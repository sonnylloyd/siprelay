import crypto from 'node:crypto';
import { createPool, Pool, PoolOptions, RowDataPacket } from 'mysql2/promise';
import { DeviceChange, PushStorage, StoredState, readDevice, readSecret } from './PushStorage';

function execute(connection: Pick<Pool, 'execute'>, sql: string, parameters: Array<string | number> = []) {
  return connection.execute<RowDataPacket[]>({ sql, timeout: 5000 }, parameters);
}

export class MysqlPushStorage implements PushStorage {
  private pool?: Pool;
  constructor(private readonly options: PoolOptions) {}

  async open(): Promise<StoredState> {
    const pool = this.pool = createPool({ ...this.options, connectionLimit: 1, connectTimeout: 5000, multipleStatements: false });
    await execute(pool, 'CREATE TABLE IF NOT EXISTS siprelay_push_meta (id TINYINT PRIMARY KEY, secret CHAR(64) NOT NULL) ENGINE=InnoDB');
    await execute(pool, 'CREATE TABLE IF NOT EXISTS siprelay_push_devices (id CHAR(64) PRIMARY KEY, write_order BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE, payload MEDIUMTEXT NOT NULL, expires_at BIGINT NOT NULL) ENGINE=InnoDB');
    await execute(pool, 'INSERT IGNORE INTO siprelay_push_meta (id, secret) VALUES (1, ?)', [crypto.randomBytes(32).toString('hex')]);
    const [metadata] = await execute(pool, 'SELECT secret FROM siprelay_push_meta WHERE id=1');
    await execute(pool, 'DELETE FROM siprelay_push_devices WHERE expires_at <= ?', [Date.now()]);
    const [rows] = await execute(pool, 'SELECT payload FROM siprelay_push_devices ORDER BY write_order');
    return { secret: readSecret(metadata[0].secret), devices: rows.map(row => readDevice(row.payload)) };
  }

  async write(changes: DeviceChange[]): Promise<void> {
    const connection = await this.pool!.getConnection();
    try {
      await connection.query({ sql: 'START TRANSACTION', timeout: 5000 });
      for (const { key, device } of changes) {
        if (device) await execute(connection, 'REPLACE INTO siprelay_push_devices (id, payload, expires_at) VALUES (?, ?, ?)', [key, JSON.stringify(device), device.expiresAt]);
        else await execute(connection, 'DELETE FROM siprelay_push_devices WHERE id=?', [key]);
      }
      await connection.query({ sql: 'COMMIT', timeout: 5000 });
    } catch (error) { await connection.query({ sql: 'ROLLBACK', timeout: 5000 }); throw error; }
    finally { connection.release(); }
  }

  async close(): Promise<void> { await this.pool?.end(); this.pool = undefined; }
}
