import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from 'mysql2/promise';
import { MysqlPushStorage } from '../src/store/persistence/MysqlPushStorage';
import { createPushStorage } from '../src/store/persistence/createPushStorage';
import { MemoryPushStorage, SavedDevice } from '../src/store/persistence/PushStorage';
import { SqlitePushStorage } from '../src/store/persistence/SqlitePushStorage';
import { Config } from '../src/configurations';
vi.mock('mysql2/promise', () => ({ createPool: vi.fn() }));
const device: SavedDevice = { domain: 'pbx.test', user: 'alice', transport: 'TCP', expiresAt: Date.now() + 5000, push: { provider: 'fcm', token: 'private', app: 'our-app' } };
const connection = { execute: vi.fn(), query: vi.fn(), release: vi.fn() };
const pool = { execute: vi.fn(), getConnection: vi.fn(async () => connection), end: vi.fn() };
beforeEach(() => {
  vi.mocked(createPool).mockReturnValue(pool as unknown as ReturnType<typeof createPool>);
  pool.execute.mockImplementation(async ({ sql }: { sql: string }) => {
    if (sql.startsWith('SELECT secret')) return [[{ secret: 'ab'.repeat(32) }]];
    if (sql.startsWith('SELECT payload')) return [[{ payload: JSON.stringify(device) }]];
    return [[]];
  });
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('MySQL push storage', () => {
  it('creates schema, loads private signing key, prunes expiry and restores push metadata', async () => {
    const storage = new MysqlPushStorage({ host: 'db', database: 'siprelay', password: 'private', multipleStatements: true });
    const state = await storage.open();
    expect(state.secret).toEqual(Buffer.from('ab'.repeat(32), 'hex')); expect(state.devices).toEqual([device]);
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({ multipleStatements: false, connectionLimit: 1, connectTimeout: 5000 }));
    expect(pool.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: expect.stringContaining('DELETE FROM'), timeout: 5000 }), [expect.any(Number)]);
    await storage.write([{ key: 'one', device }, { key: 'two' }]);
    expect(connection.query).toHaveBeenCalledWith({ sql: 'START TRANSACTION', timeout: 5000 }); expect(connection.query).toHaveBeenCalledWith({ sql: 'COMMIT', timeout: 5000 });
    expect(connection.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: expect.stringContaining('VALUES (?, ?, ?)'), timeout: 5000 }), ['one', JSON.stringify(device), device.expiresAt]);
    expect(connection.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: expect.stringContaining('WHERE id=?'), timeout: 5000 }), ['two']);
    expect(connection.release).toHaveBeenCalledOnce(); await storage.close(); await storage.close(); expect(pool.end).toHaveBeenCalledOnce();
  });
  it('rolls back and releases connections when an SQL statement fails', async () => {
    const storage = new MysqlPushStorage({}); await storage.open();
    connection.execute.mockRejectedValueOnce(new Error('write failed'));
    await expect(storage.write([{ key: 'one', device }])).rejects.toThrow('write failed');
    expect(connection.query).toHaveBeenCalledWith({ sql: 'ROLLBACK', timeout: 5000 }); expect(connection.query).not.toHaveBeenCalledWith({ sql: 'COMMIT', timeout: 5000 }); expect(connection.release).toHaveBeenCalledOnce(); await storage.close();
  });
  it('propagates connection acquisition, transaction and commit failures for retry', async () => {
    const storage = new MysqlPushStorage({}); await storage.open();
    pool.getConnection.mockRejectedValueOnce(new Error('offline'));
    await expect(storage.write([])).rejects.toThrow('offline'); expect(connection.release).not.toHaveBeenCalled();
    connection.query.mockRejectedValueOnce(new Error('begin failed'));
    await expect(storage.write([])).rejects.toThrow('begin failed'); expect(connection.release).toHaveBeenCalledOnce();
    connection.query.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('commit failed'));
    await expect(storage.write([])).rejects.toThrow('commit failed'); expect(connection.query.mock.calls.filter(([query]) => query.sql === 'ROLLBACK')).toHaveLength(2); await storage.close();
  });
});

describe('configurable backend selection', () => {
  it('defaults to memory and allows explicit SQLite selection', () => {
    vi.stubEnv('PUSH_STORAGE', undefined); expect(new Config().PUSH_STORAGE).toBe('memory');
    expect(createPushStorage(new Config())).toBeInstanceOf(MemoryPushStorage);
    expect(createPushStorage({} as Config)).toBeInstanceOf(MemoryPushStorage);
    vi.stubEnv('PUSH_STORAGE', 'sqlite'); vi.stubEnv('PUSH_SQLITE_PATH', '/data/custom.sqlite');
    const config = new Config(); expect(config.PUSH_SQLITE_PATH).toBe('/data/custom.sqlite'); expect(createPushStorage(config)).toBeInstanceOf(SqlitePushStorage);
  });
  it('uses validated MySQL settings and certificate verification by default', async () => {
    for (const [key, value] of Object.entries({ PUSH_STORAGE: 'mysql', PUSH_MYSQL_HOST: 'db.example', PUSH_MYSQL_PORT: '3307',
      PUSH_MYSQL_DATABASE: 'relay', PUSH_MYSQL_USER: 'relay-user', PUSH_MYSQL_PASSWORD: 'secret', PUSH_MYSQL_TLS: '1', PUSH_MYSQL_CA_PATH: '/test-ca' })) vi.stubEnv(key, value);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('CA'));
    const storage = createPushStorage(new Config()); await storage.open();
    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({ host: 'db.example', port: 3307, database: 'relay', user: 'relay-user', password: 'secret',
      ssl: { ca: Buffer.from('CA'), rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } })); await storage.close();
    vi.stubEnv('PUSH_MYSQL_CA_PATH', ''); const defaultCA = createPushStorage(new Config()); await defaultCA.open();
    expect(createPool).toHaveBeenLastCalledWith(expect.objectContaining({ ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } })); await defaultCA.close();
    vi.stubEnv('PUSH_MYSQL_TLS', '0'); const plain = createPushStorage(new Config()); await plain.open(); expect(createPool).toHaveBeenLastCalledWith(expect.objectContaining({ ssl: undefined })); await plain.close();
  });
  it('rejects unknown backends and invalid ports only for the selected MySQL backend', () => {
    vi.stubEnv('PUSH_STORAGE', 'typo'); expect(() => new Config()).toThrow('PUSH_STORAGE');
    vi.stubEnv('PUSH_STORAGE', 'mysql');
    for (const port of ['0', '65536', '3306.5', 'oops', '']) { vi.stubEnv('PUSH_MYSQL_PORT', port); expect(() => new Config()).toThrow('PUSH_MYSQL_PORT'); }
    vi.stubEnv('PUSH_STORAGE', 'memory'); expect(() => new Config()).not.toThrow();
  });
});

it('rejects volatile SQLite paths when persistent SQLite is selected', () => {
  vi.stubEnv('PUSH_STORAGE', 'sqlite'); vi.stubEnv('PUSH_SQLITE_PATH', ':memory:');
  expect(() => new Config()).toThrow('persistent file');
  vi.stubEnv('PUSH_STORAGE', 'memory'); expect(() => new Config()).not.toThrow();
});

it('requires a DNS identity for TLS MySQL but allows IPs in an explicit plaintext lab', () => {
  vi.stubEnv('PUSH_STORAGE', 'mysql'); vi.stubEnv('PUSH_MYSQL_TLS', '1');
  for (const host of ['127.0.0.1', '::1']) {
    vi.stubEnv('PUSH_MYSQL_HOST', host); expect(() => new Config()).toThrow('DNS hostname');
  }
  vi.stubEnv('PUSH_MYSQL_HOST', 'mysql.internal'); expect(new Config().PUSH_MYSQL_HOST).toBe('mysql.internal');
  vi.stubEnv('PUSH_MYSQL_HOST', '127.0.0.1'); vi.stubEnv('PUSH_MYSQL_TLS', '0'); expect(new Config().PUSH_MYSQL_HOST).toBe('127.0.0.1');
});
