import { Logger } from '../../logging/Logger';
import { DeviceChange, PushStorage } from './PushStorage';

/** Coalesces each device's latest state while a database batch is in flight. */
export class DeviceWriter {
  private readonly pending = new Map<string, DeviceChange>();
  private running?: Promise<void>;
  private retry?: NodeJS.Timeout;
  private failed = false;
  private stopped = false;

  constructor(private readonly storage: PushStorage, private readonly logger?: Logger) {}
  get healthy(): boolean { return !this.failed; }

  change(change: DeviceChange): void {
    if (this.stopped) return;
    this.pending.delete(change.key);
    this.pending.set(change.key, change);
    this.start();
  }

  private start(): void {
    if (this.running || this.retry) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.pending.size && !this.retry) this.start();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.size) {
      const changes = [...this.pending.values()];
      this.pending.clear();
      try { await this.storage.write(changes); this.failed = false; }
      catch {
        // Never log provider tokens, SQL parameters, connection URLs or passwords.
        this.logger?.error('Push storage write failed; retrying. Restart recovery is degraded.');
        this.failed = true;
        const newer = [...this.pending.values()];
        this.pending.clear();
        for (const change of [...changes, ...newer]) {
          this.pending.delete(change.key); this.pending.set(change.key, change);
        }
        this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, 1000);
        this.retry.unref();
        return;
      }
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.retry); this.retry = undefined;
    this.start();
    while (this.running) {
      await this.running;
      if (this.failed) throw new Error('Push storage flush failed');
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    try { await this.flush(); }
    finally { clearTimeout(this.retry); await this.storage.close(); }
  }
}
