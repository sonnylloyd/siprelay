import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DeviceChange, PushStorage, StoredState, readDevice, readSecret } from './PushStorage';

export class SqlitePushStorage implements PushStorage {
  private db?: DatabaseSync;
  constructor(private readonly filename: string) {}

  async open(): Promise<StoredState> {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    // Create privately before SQLite opens it; an existing file must also be private.
    const fd = fs.openSync(this.filename, 'a', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    const { DatabaseSync } = await import('node:sqlite');
    const db = this.db = new DatabaseSync(this.filename);
    db.exec('PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    db.exec('CREATE TABLE IF NOT EXISTS siprelay_push_meta (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL); CREATE TABLE IF NOT EXISTS siprelay_push_devices (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);');
    db.prepare('INSERT OR IGNORE INTO siprelay_push_meta (id, secret) VALUES (1, ?)').run(crypto.randomBytes(32).toString('hex'));
    const row = db.prepare('SELECT secret FROM siprelay_push_meta WHERE id=1').get()!;
    db.prepare('DELETE FROM siprelay_push_devices WHERE expires_at <= ?').run(Date.now());
    const devices = db.prepare('SELECT payload FROM siprelay_push_devices ORDER BY rowid').all().map(row => readDevice(row.payload as string));
    return { secret: readSecret(row.secret as string), devices };
  }

  async write(changes: DeviceChange[]): Promise<void> {
    const db = this.db!;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { key, device } of changes) {
        if (device) db.prepare('INSERT OR REPLACE INTO siprelay_push_devices (id, payload, expires_at) VALUES (?, ?, ?)').run(key, JSON.stringify(device), device.expiresAt);
        else db.prepare('DELETE FROM siprelay_push_devices WHERE id=?').run(key);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  async close(): Promise<void> { this.db?.close(); this.db = undefined; }
}
