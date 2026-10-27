import { EventEmitter } from 'events';
import tls from 'tls';
import { vi } from 'vitest';

export class FakeTlsSocket extends EventEmitter {
  readonly writes: string[] = [];
  readonly rawWrites: Buffer[] = [];
  destroyed = false;
  writeBlocked = false;
  writeError?: Error;
  remoteAddress = '198.51.100.10';
  remotePort = 5090;
  setKeepAlive = vi.fn();
  setTimeout = vi.fn((_timeout: number, _listener: () => void) => {});

  write(payload: string | Buffer): boolean {
    if (this.writeError) throw this.writeError;
    this.rawWrites.push(Buffer.from(payload));
    this.writes.push(payload.toString());
    return !this.writeBlocked;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  data(payload: string | Buffer): void {
    this.emit('data', Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  }

  asSocket(): tls.TLSSocket {
    return this as unknown as tls.TLSSocket;
  }
}

export class FakeTlsServer {
  constructor(private readonly listener: (socket: tls.TLSSocket) => void) {}
  listen = vi.fn((_port: number, _host: string, callback: () => void) => { callback(); });
  accept(socket: FakeTlsSocket): void { this.listener(socket.asSocket()); }
  asServer(): tls.Server { return this as unknown as tls.Server; }
}
