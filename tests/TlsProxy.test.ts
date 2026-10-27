import { PushSender } from '../src/push/types';
import { PushCoordinator } from '../src/push/PushCoordinator';
import { SipMessage } from '../src/sip';
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

  constructor(_name: string) {
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
  private listener?: ((socket: tls.TLSSocket) => void);

  listen(_port: number, _host: string, cb?: () => void): this {
    cb?.();
    return this;
  }

  setListener(listener: ((socket: tls.TLSSocket) => void)): void {
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

const createSipResponse = (branch: string, callId = 'call-1'): string =>
  [
    'SIP/2.0 200 OK',
    `Via: SIP/2.0/TLS 203.0.113.5:5061;branch=${branch}`,
    'Via: SIP/2.0/TLS 198.51.100.20:5092;branch=z9hG4bK-client;rport',
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
  let pushSender: PushSender;

  beforeEach(() => {
    clientSocket = new FakeTLSSocket('client');
    clientSocket.remoteAddress = '198.51.100.20';
    clientSocket.remotePort = 5092;
    upstreamSocket = new FakeTLSSocket('upstream');
    fakeServer = new FakeTlsServer();
    logger = createTestLogger();
    config = createTestConfig({ SIP_TLS_PORT: 5061, PROXY_IP: '203.0.113.5' });
    registrationStore = new RegistrationStore();
    pushSender = { supports: () => true, send: vi.fn().mockResolvedValue(undefined) };

    const serverFactory = vi.fn((_options: tls.TlsOptions, listener: ((socket: tls.TLSSocket) => void)) => {
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
      pushCoordinator: new PushCoordinator(registrationStore, pushSender, logger),
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

    const storedClient = (tlsProxy as any).clientMap.values().next().value;
    expect(storedClient?.socket).toBe(clientSocket);
  });

  it('forwards upstream SIP responses back to the client transport', async () => {
    const request = createSipRequest('pbx.internal');
    clientSocket.emitData(request);
    await flushAsync();

    const storedClient = (tlsProxy as any).clientMap.values().next().value;
    const proxyBranch = storedClient?.proxyBranch as string;
    expect(proxyBranch).toBeTruthy();

    const response = createSipResponse(proxyBranch);
    upstreamSocket.emitData(response);
    await flushAsync();

    expect(clientSocket.writes).toHaveLength(1);
    expect(clientSocket.writes[0]).toContain('SIP/2.0/TLS 198.51.100.20:5092');
  });
  it('wakes a disconnected TLS phone and delivers only after its authenticated registration refresh', async () => {
    const register = (id: string) => createSipRequest('pbx.internal', id)
      .replaceAll('INVITE', 'REGISTER')
      .replace('To: <sip:bob@example.com>', 'To: <sip:alice@pbx.internal>')
      .replace('Contact: <sip:alice@198.51.100.20>',
        'Contact: <sip:alice@198.51.100.20;pn-provider=fcm;pn-param=our-project;pn-prid=secret>');
    const acceptRegister = (index: number, id: string) => {
      const request = new SipMessage(upstreamSocket.writes[index]);
      const response = createSipResponse(request.getBranchFromVia(request.getTopVia()!)!, id)
        .replace('CSeq: 1 INVITE', 'CSeq: 1 REGISTER')
        .replace('Content-Length: 0', 'Contact: <sip:alice@203.0.113.5>;expires=600\r\nContent-Length: 0');
      upstreamSocket.emitData(response);
    };
    clientSocket.emitData(register('register-old'));
    await flushAsync();
    acceptRegister(0, 'register-old');
    await flushAsync();
    expect(registrationStore.get('pbx.internal', 'alice')?.socket).toBe(clientSocket);
    clientSocket.destroy();

    const incoming = createSipRequest('alice@203.0.113.5', 'incoming')
      .replace('To: <sip:bob@example.com>', 'To: <sip:alice@pbx.internal>');
    upstreamSocket.emitData(incoming);
    await flushAsync();
    expect(pushSender.send).toHaveBeenCalledTimes(1);
    expect(upstreamSocket.writes.at(-1)).toContain('100 Trying');

    const fresh = new FakeTLSSocket('woken-phone');
    fresh.remoteAddress = '198.51.100.22'; fresh.remotePort = 5099;
    fakeServer.accept(fresh);
    fresh.emitData(register('register-new'));
    await flushAsync();
    const registrationIndex = upstreamSocket.writes.length - 1;
    expect(fresh.writes).toHaveLength(0);
    acceptRegister(registrationIndex, 'register-new');
    await flushAsync();
    expect(fresh.writes[0]).toContain('CSeq: 1 REGISTER');
    expect(fresh.writes[1]).toContain('Call-ID: incoming');
    expect(fresh.writes[1]).toContain('INVITE');

    const invite = new SipMessage(fresh.writes[1]);
    const response = createSipResponse(invite.getBranchFromVia(invite.getTopVia()!)!, 'incoming');
    fresh.emitData(response);
    await flushAsync();
    const forwarded = new SipMessage(upstreamSocket.writes.at(-1)!);
    expect(forwarded.getHeader('Via')).toHaveLength(1);
    expect(forwarded.getTopVia()).toContain('z9hG4bK-client');
  });

  it('accepts a new TLS connection from a discovered PBX and pins responses to the phone socket', async () => {
    registrationStore.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: '198.51.100.20', clientPort: 5092,
      transport: 'TLS', socket: clientSocket as any, expiresAt: Date.now() + 60000 });
    const pbx = new FakeTLSSocket('pbx'); pbx.remoteAddress = '::ffff:10.0.0.50'; pbx.remotePort = 55000;
    fakeServer.accept(pbx);
    pbx.emitData(createSipRequest('alice@203.0.113.5', 'pbx-new-connection')
      .replace('To: <sip:bob@example.com>', 'To: <sip:alice@pbx.internal>'));
    await flushAsync();
    expect(clientSocket.writes).toHaveLength(1);
    const forwarded = new SipMessage(clientSocket.writes[0]);
    const response = createSipResponse(forwarded.getBranchFromVia(forwarded.getTopVia()!)!, 'pbx-new-connection');
    const attacker = new FakeTLSSocket('attacker'); attacker.remoteAddress = '198.51.100.99';
    fakeServer.accept(attacker); attacker.emitData(response);
    await flushAsync();
    expect(pbx.writes).toHaveLength(0);
    clientSocket.emitData(response);
    await flushAsync();
    expect(pbx.writes).toHaveLength(1);
    expect(new SipMessage(pbx.writes[0]).getHeader('Via')).toHaveLength(1);
  });

});
