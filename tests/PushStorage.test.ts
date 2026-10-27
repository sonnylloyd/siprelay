import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistrationBinding, RegistrationStore } from '../src/store';
import { MemoryPushStorage, PushStorage, SavedDevice, deviceKey, readDevice, readSecret, saveDevice } from '../src/store/persistence/PushStorage';
import { SqlitePushStorage } from '../src/store/persistence/SqlitePushStorage';
import { DeviceWriter } from '../src/store/persistence/DeviceWriter';
import { createTestLogger } from './utils';

const directories: string[] = [];
const filename = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'siprelay-storage-')); directories.push(directory); return path.join(directory, 'private', 'push.sqlite'); };
const device = (overrides: Partial<RegistrationBinding> = {}): RegistrationBinding => ({
  domain: 'PBX.example', user: 'Alice', id: 'device-one', transport: 'UDP',
  clientAddress: '192.0.2.99', clientPort: 5555, contact: '<sip:Alice@private>', clientContact: '<sip:Alice@private>',
  push: { provider: 'fcm', token: 'secret-device-token', app: 'our.app' }, expiresAt: Date.now() + 60_000, ...overrides,
});
const adapter = (devices: SavedDevice[] = []): PushStorage => ({
  open: vi.fn(async () => ({ secret: Buffer.alloc(32, 1), devices })), write: vi.fn(async () => {}), close: vi.fn(async () => {}),
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('SQLite restart recovery', () => {
  it('retains signed route identity and multiple tenants/devices, but requires a fresh connection', async () => {
    const file = filename();
    const first = new RegistrationStore(new SqlitePushStorage(file));
    expect(first.storageHealthy).toBe(false);
    expect(() => first.upsert(device())).toThrow('not initialized');
    expect(first.initialize()).toBe(first.initialize());
    await first.initialize();
    const flowToken = first.createFlowToken({ domain: 'pbx.example', user: 'Alice', flow: 'original-flow' });
    first.upsert(device({ flowToken })); first.upsert(device({ id: 'device-two', transport: 'TLS' }));
    first.upsert(device({ domain: 'other.example' })); first.upsert(device({ user: 'no-push', push: undefined }));
    await first.close();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = new DatabaseSync(file);
    const rows = raw.prepare('SELECT payload FROM siprelay_push_devices').all(); raw.close();
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain('192.0.2.99'); expect(JSON.stringify(rows)).not.toContain('clientContact');
    const restored = new RegistrationStore(new SqlitePushStorage(file));
    const listener = vi.fn(); restored.onRegistered(listener);
    await restored.initialize();
    expect(restored.storageHealthy).toBe(true); expect(listener).not.toHaveBeenCalled();
    expect(restored.getByFlowToken(flowToken)).toMatchObject({ dormant: true, clientAddress: '', clientPort: 0, push: device().push });
    expect(restored.getAll('pbx.example', 'Alice')).toHaveLength(2);
    expect(restored.get('other.example', 'Alice')).toBeDefined(); expect(restored.get('pbx.example', 'no-push')).toBeUndefined();
    restored.upsert(device({ flowToken })); expect(restored.getByFlowToken(flowToken)?.dormant).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce(); await restored.close();
  });

  it('persists token rotation, loss of push support, per-Contact and wildcard unregisters', async () => {
    const file = filename();
    const open = async () => { const store = new RegistrationStore(new SqlitePushStorage(file)); await store.initialize(); return store; };
    let store = await open();
    store.upsert(device()); store.upsert(device({ push: { provider: 'apns', token: 'rotated', app: 'our.app.voip' } }));
    await store.close(); store = await open();
    expect(store.get('pbx.example', 'Alice')?.push?.token).toBe('rotated');
    store.upsert(device({ push: undefined })); store.upsert(device({ id: 'two' })); store.upsert(device({ id: 'three' }));
    expect(store.remove('PBX.example', 'Alice', 'two')).toBe(true);
    await store.close(); store = await open();
    expect(store.getAll('pbx.example', 'Alice').map(value => value.id)).toEqual(['three']);
    store.remove('pbx.example', 'Alice'); await store.close(); store = await open();
    expect(store.getAll('pbx.example', 'Alice')).toEqual([]); await store.close();
  });

  it('does not restore expired registrations and durably purges records expired during runtime', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const file = filename(); let store = new RegistrationStore(new SqlitePushStorage(file)); await store.initialize();
    store.upsert(device({ expiresAt: 1001 })); store.upsert(device({ user: 'other', expiresAt: 1002 })); await store.close();
    vi.mocked(Date.now).mockReturnValue(1001);
    store = new RegistrationStore(new SqlitePushStorage(file)); await store.initialize();
    expect(store.get('pbx.example', 'Alice')).toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(1002); store.purgeExpired(); await store.close();
    const db = new DatabaseSync(file); expect(db.prepare('SELECT * FROM siprelay_push_devices').all()).toEqual([]); db.close();
  });

  it('fails startup on corrupt secrets and malformed device data', async () => {
    const file = filename(); const storage = new SqlitePushStorage(file); await storage.open(); await storage.close();
    let db = new DatabaseSync(file); db.exec("UPDATE siprelay_push_meta SET secret='invalid'"); db.close();
    await expect(new RegistrationStore(new SqlitePushStorage(file)).initialize()).rejects.toThrow('Unable to initialize');
    db = new DatabaseSync(file); db.prepare('UPDATE siprelay_push_meta SET secret=?').run('11'.repeat(32));
    db.prepare('INSERT INTO siprelay_push_devices VALUES (?, ?, ?)').run('corrupt', '{}', Date.now() + 5000); db.close();
    await expect(new RegistrationStore(new SqlitePushStorage(file)).initialize()).rejects.toThrow('Unable to initialize');
  });

  it('rolls back a batch if any statement fails and allows close before open', async () => {
    const file = filename(); const storage = new SqlitePushStorage(file); await storage.open();
    const db = new DatabaseSync(file); db.exec("CREATE TRIGGER reject_push BEFORE INSERT ON siprelay_push_devices WHEN NEW.id='reject' BEGIN SELECT RAISE(ABORT, 'test'); END;");
    await expect(storage.write([{ key: 'good', device: saveDevice(device()) }, { key: 'reject', device: saveDevice(device()) }])).rejects.toThrow('test');
    expect(db.prepare('SELECT * FROM siprelay_push_devices').all()).toEqual([]); db.close(); await storage.close(); await storage.close();
  });
});

describe('storage input validation', () => {
  it('keeps only the persistence whitelist and normalizes identifiers', () => {
    const saved = saveDevice(device({ transport: undefined }))!;
    expect(saved.transport).toBe('UDP'); expect(saved.domain).toBe('pbx.example');
    expect(readDevice(JSON.stringify({ ...saved, socket: 'unexpected' }))).toEqual(saved);
    expect(saveDevice(device({ expiresAt: 0 }))).toBeUndefined();
    expect(saveDevice(device({ push: undefined }))).toBeUndefined();
    expect(deviceKey(device())).toBe(deviceKey(device({ domain: 'pbx.example' })));
    expect(deviceKey(device({ id: undefined }))).not.toBe(deviceKey(device()));
    expect(readSecret('ab'.repeat(32))).toHaveLength(32); expect(() => readSecret('broken')).toThrow();
  });
  it.each([
    null, {}, { domain: '' }, { user: 1 }, { user: '' }, { id: 4 }, { transport: 'WS' },
    { expiresAt: 1.1 }, { expiresAt: -1 }, { flowToken: 2 }, { push: null }, { push: { provider: 'unknown' } },
    { push: { provider: 'fcm', token: '', app: 'app' } }, { push: { provider: 'apns', token: 't', app: '' } },
    { push: { provider: 'fcm', token: 9, app: 'app' } }, { push: { provider: 'fcm', token: 't', app: 1 } },
  ])('rejects malformed record %j', invalid => {
    const value = invalid === null ? null : { ...saveDevice(device()), ...invalid };
    // {} alone is valid after merging; test it unmerged as a missing-field record.
    expect(() => readDevice(JSON.stringify(invalid && Object.keys(invalid).length ? value : invalid))).toThrow();
  });
});

describe('store lifecycle and persistence failure handling', () => {
  it('retains memory-only behavior with or without an explicit memory adapter', async () => {
    const memory = new MemoryPushStorage(); expect((await memory.open()).devices).toEqual([]); await memory.write([]); await memory.close();
    const store = new RegistrationStore(); await store.initialize(); store.upsert(device()); expect(store.storageHealthy).toBe(true); await store.flush(); await store.close();
  });
  it('does not notify for expired restores and refuses cross-tenant or forged route handles', async () => {
    const first = new RegistrationStore(adapter()); await first.initialize();
    const flowToken = first.createFlowToken({ domain: 'pbx.example', user: 'Alice', flow: 'device' });
    for (const changed of [{ flowToken: 'forged' }, { flowToken, domain: 'evil.example' }, { flowToken, user: 'Bob' }]) {
      const storage = adapter([{ ...saveDevice(device())!, ...changed }]);
      await expect(new RegistrationStore(storage).initialize()).rejects.toThrow('Unable to initialize'); expect(storage.close).toHaveBeenCalledOnce();
    }
    const store = new RegistrationStore(adapter([saveDevice(device({ expiresAt: 1 })) ?? { ...saveDevice(device())!, expiresAt: 1 }]));
    await store.initialize(); expect(store.get('pbx.example', 'Alice')).toBeUndefined(); await store.close(); await first.close();
  });
  it('persists expiry discovered by lookup and deletion of legacy bindings', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10); const storage = adapter(); const store = new RegistrationStore(storage); await store.initialize();
    store.upsert(device({ expiresAt: 11, id: undefined })); await store.flush();
    vi.mocked(Date.now).mockReturnValue(11); expect(store.getAll('pbx.example', 'Alice')).toEqual([]); await store.flush();
    expect(storage.write).toHaveBeenLastCalledWith([{ key: deviceKey(device({ id: undefined })), device: undefined }]);
    store.upsert(device({ expiresAt: 50 })); expect(store.remove('pbx.example', 'Alice', 'missing')).toBe(false); store.remove('pbx.example', 'Alice', 'device-one'); await store.close();
  });
  it('coalesces updates during writes, preserves newer changes on failure, retries and exposes health', async () => {
    vi.useFakeTimers(); const storage = adapter(); const logger = createTestLogger();
    let reject!: (error: Error) => void;
    vi.mocked(storage.write).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const writer = new DeviceWriter(storage, logger);
    writer.change({ key: 'one', device: saveDevice(device()) });
    writer.change({ key: 'one' }); writer.change({ key: 'two' });
    reject(new Error('secret SQL data')); await Promise.resolve(); await Promise.resolve();
    expect(writer.healthy).toBe(false); expect(logger.error).toHaveBeenCalledWith(expect.not.stringContaining('secret SQL data'));
    await vi.advanceTimersByTimeAsync(1000); await writer.flush();
    expect(storage.write).toHaveBeenLastCalledWith(expect.arrayContaining([{ key: 'one' }, { key: 'two' }])); expect(writer.healthy).toBe(true);
    await writer.close(); writer.change({ key: 'ignored' }); expect(storage.close).toHaveBeenCalledOnce();
  });
  it('reports a failed flush, closes resources, and retries a failed batch on explicit flush', async () => {
    vi.useFakeTimers(); const storage = adapter(); vi.mocked(storage.write).mockRejectedValue(new Error('outage'));
    const writer = new DeviceWriter(storage); writer.change({ key: 'one' });
    await expect(writer.flush()).rejects.toThrow('flush failed');
    vi.mocked(storage.write).mockResolvedValue(undefined); await writer.flush(); expect(writer.healthy).toBe(true);
    writer.change({ key: 'two' }); await writer.close();
    const bad = adapter(); vi.mocked(bad.write).mockRejectedValue(new Error('down'));
    const broken = new DeviceWriter(bad); broken.change({ key: 'one' }); await expect(broken.close()).rejects.toThrow(); expect(bad.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reflects failed writes through RegistrationStore health', async () => {
    const storage = adapter(); vi.mocked(storage.write).mockRejectedValue(new Error('offline'));
    const store = new RegistrationStore(storage); await store.initialize(); store.upsert(device());
    await expect(store.flush()).rejects.toThrow(); expect(store.storageHealthy).toBe(false);
    vi.mocked(storage.write).mockResolvedValue(undefined); await store.close();
  });
});

it('flushes a change arriving between completion of a batch and its final cleanup', async () => {
  const storage = adapter(); const writer = new DeviceWriter(storage);
  writer.change({ key: 'first' }); await Promise.resolve(); writer.change({ key: 'second' });
  await writer.flush(); expect(storage.write).toHaveBeenCalledTimes(2); expect(storage.write).toHaveBeenLastCalledWith([{ key: 'second' }]); await writer.close();
});
