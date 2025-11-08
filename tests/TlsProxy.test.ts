import { EventEmitter } from 'events';
import { setImmediate } from 'timers';
import tls from 'tls';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TlsProxy } from '../src/proxies/TlsProxy';
import { MemoryStore, RegistrationStore } from '../src/store';
import { createTestConfig, createTestLogger } from './utils';
import type { Logger } from '../src/logging/Logger';
import type { Config } from '../src/configurations';

class FakeTLSSocket extends EventEmitter {
  public writes: string[] = [];
  public destroyed = false;
  public remoteAddress?: string;
  public remotePort?: number;

  constructor(private readonly name: string) {
    super();
  }

  write(payload: string | Buffer): boolean {
    const text = typeof payload === 'string' ? payload : payload.toString();
    this.writes.push(text);
    return true;
  }

  setKeepAlive(_value: boolean): void {
    // no-op for tests
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }

  emitData(payload: string): void {
    this.emit('data', Buffer.from(payload));
  }
}

class FakeTlsServer {
  private listener?: tls.ConnectionListener;

  listen(_port: number, _host: string, cb?: () => void): this {
    cb?.();
    return this;
  }

  setListener(listener: tls.ConnectionListener): void {
    this.listener = listener;
  }

  accept(socket: FakeTLSSocket): void {
    this.listener?.(socket as unknown as tls.TLSSocket);
  }
}

const createSipRequest = (host: string, callId = 'call-1'): string =>
  [
    `INVITE sip:${host} SIP/2.0`,
    'Via: SIP/2.0/TLS 198.51.100.20:5092;branch=z9hG4bK-client;rport',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Contact: <sip:alice@198.51.100.20>',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

const createSipResponse = (callId = 'call-1'): string =>
  [
    'SIP/2.0 200 OK',
    'Via: SIP/2.0/TLS 203.0.113.5:5061;branch=z9hG4bK-proxy',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>;tag=xyz',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

describe('TlsProxy', () => {
  let clientSocket: FakeTLSSocket;
  let upstreamSocket: FakeTLSSocket;
  let fakeServer: FakeTlsServer;
  let tlsProxy: TlsProxy;
  let logger: Logger;
  let config: Config;
  let registrationStore: RegistrationStore;

  beforeEach(() => {
    clientSocket = new FakeTLSSocket('client');
    clientSocket.remoteAddress = '198.51.100.20';
    clientSocket.remotePort = 5092;
    upstreamSocket = new FakeTLSSocket('upstream');
    fakeServer = new FakeTlsServer();
    logger = createTestLogger();
    config = createTestConfig({ SIP_TLS_PORT: 5061, PROXY_IP: '203.0.113.5' });
    registrationStore = new RegistrationStore();

    const serverFactory = vi.fn((_options: tls.TlsOptions, listener: tls.ConnectionListener) => {
      fakeServer.setListener(listener);
      return fakeServer as unknown as tls.Server;
    });

    const tlsConnect = vi.fn((_options: tls.ConnectionOptions) => {
      setImmediate(() => upstreamSocket.emit('secureConnect'));
      return upstreamSocket as unknown as tls.TLSSocket;
    });

    const records = new MemoryStore();
    records.addRecord('pbx.internal', { ip: '10.0.0.50', tlsPort: 5071 });

    tlsProxy = new TlsProxy(records, config, logger, registrationStore, {
      tlsOptions: { key: Buffer.from('key'), cert: Buffer.from('cert') },
      serverFactory,
      tlsConnect,
    });
    tlsProxy.start();
    fakeServer.accept(clientSocket);
  });

  it('buffers chunked client data and forwards complete messages upstream', async () => {
    const request = createSipRequest('pbx.internal');
    clientSocket.emit('data', Buffer.from(request.slice(0, 40)));
    await flushAsync();
    clientSocket.emit('data', Buffer.from(request.slice(40)));
    await flushAsync();

    expect(upstreamSocket.writes).toHaveLength(1);
    expect(upstreamSocket.writes[0]).toContain('SIP/2.0/TLS 203.0.113.5:5061');

    const storedClient = (tlsProxy as any).clientMap.get('call-1');
    expect(storedClient?.socket).toBe(clientSocket);
  });

  it('forwards upstream SIP responses back to the client transport', async () => {
    const request = createSipRequest('pbx.internal');
    clientSocket.emitData(request);
    await flushAsync();

    const response = createSipResponse();
    upstreamSocket.emitData(response);
    await flushAsync();

    expect(clientSocket.writes).toHaveLength(1);
    expect(clientSocket.writes[0]).toContain('SIP/2.0/TLS 198.51.100.20:5092');
  });
});
