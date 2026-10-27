import net from 'net';
import fs from 'fs';
import { Config } from '../src/configurations';
import { PushCoordinator } from '../src/push/PushCoordinator';
import tls from 'tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TcpProxy } from '../src/proxies/TcpProxy';
import { TlsProxy } from '../src/proxies/TlsProxy';
import { MemoryStore, RegistrationStore } from '../src/store';
import { FakeTlsServer, FakeTlsSocket } from './fixtures/transports';
import { createTestConfig, createTestLogger } from './utils';
import { flushAsync, sipRequest, sipResponse } from './fixtures/sip';
import { SipMessage } from '../src/sip';

const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
function fixture(tlsMode = false, pathMode = false, config: Partial<Config> = {}) {
  const records = new MemoryStore(); records.addRecord('pbx.internal', { ip: '10.0.0.50', tcpPort: 5060, tlsPort: 5061, tlsServerName: 'pbx.example.test' });
  const registrations = new RegistrationStore(); const client = new FakeTlsSocket(), upstream = new FakeTlsSocket();
  let server: FakeTlsServer;
  const connect = vi.fn((_options: tls.ConnectionOptions) => { queueMicrotask(() => upstream.emit(tlsMode ? 'secureConnect' : 'connect')); return upstream.asSocket(); });
  const sender = { supports: () => true, send: vi.fn().mockResolvedValue(undefined) };
  const coordinator = new PushCoordinator(registrations, sender, createTestLogger());
  const options = { pushCoordinator: coordinator, tlsOptions: {}, tlsConnect: connect, serverFactory: (_opts: object, listener: (socket: net.Socket) => void) => {
    server = new FakeTlsServer(listener); return server.asServer();
  } };
  const proxy = tlsMode ? new TlsProxy(records, createTestConfig({ SIP_TCP_PORT: 15060, SIP_REGISTRATION_MODE: pathMode ? 'path' : 'contact', ...config }), createTestLogger(), registrations, options)
    : new TcpProxy(records, createTestConfig({ SIP_TCP_PORT: 15060, SIP_REGISTRATION_MODE: pathMode ? 'path' : 'contact', ...config }), createTestLogger(), registrations, options);
  proxy.start(); server!.accept(client);
  dispose.push(() => { proxy.disposeTransactions(); coordinator.dispose(); client.destroy(); upstream.destroy(); });
  return { proxy, records, registrations, client, upstream, server: server!, connect, sender };
}

describe('plain TCP SIP transport', () => {
  it('forwards framed TCP requests/responses with TCP Via and Record-Route', async () => {
    const f = fixture(); f.client.data(sipRequest().toString()); await flushAsync();
    const request = new SipMessage(f.upstream.rawWrites[0]); expect(request.getTopVia()).toContain('/TCP ');
    expect(request.getFirstHeader('Record-Route')).toContain('transport=tcp');
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '10.0.0.50', port: 5060 }));
    f.upstream.data(sipResponse(request).toBuffer()); await flushAsync(); expect(f.client.writes[0]).toContain('200 OK');
    expect(f.server.listen).toHaveBeenCalledWith(15060, '::', expect.any(Function));
  });
  it('rejects SIPS on plain TCP and answers keepalive pings', async () => {
    const f = fixture(); const request = sipRequest(); request.startLine = 'INVITE sips:alice@pbx.internal SIP/2.0';
    f.client.data(request.toBuffer()); await flushAsync(); expect(f.client.writes[0]).toContain('416 Unsupported URI Scheme');
    expect(f.connect).not.toHaveBeenCalled(); f.client.data('\r\n\r\n'); await flushAsync(); expect(f.client.writes.at(-1)).toBe('\r\n');
  });
  it('stores accepted TCP registrations and delivers requests from that tenant PBX', async () => {
    const f = fixture(); f.client.data(sipRequest({ method: 'REGISTER' }).toBuffer()); await flushAsync();
    const register = new SipMessage(f.upstream.rawWrites[0]); const response = sipResponse(register);
    response.setHeader('Expires', '300'); f.upstream.data(response.toBuffer()); await flushAsync();
    expect(f.registrations.get('pbx.internal', 'alice')?.transport).toBe('TCP');
    const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; f.server.accept(pbx);
    pbx.data(sipRequest({ target: 'alice@203.0.113.5', callId: 'incoming' }).toBuffer()); await flushAsync();
    expect(f.client.writes.at(-1)).toContain('Call-ID: incoming'); pbx.destroy();
  });
  it('uses the native TCP server/connect factories without loading certificates', async () => {
    let listener: (socket: net.Socket) => void = () => {};
    const server = new FakeTlsServer(socket => listener(socket));
    const create = vi.spyOn(net, 'createServer').mockImplementation(((handler: (socket: net.Socket) => void) => { listener = handler; return server.asServer(); }) as unknown as typeof net.createServer);
    const upstream = new FakeTlsSocket(); const connect = vi.spyOn(net, 'connect').mockImplementation((() => {
      queueMicrotask(() => upstream.emit('connect')); return upstream.asSocket();
    }) as typeof net.connect);
    const records = new MemoryStore(); records.addRecord('pbx.internal', { ip: '10.0.0.50', tcpPort: 5060 });
    const proxy = new TcpProxy(records, createTestConfig({ SIP_TCP_PORT: 15060 }), createTestLogger(), new RegistrationStore());
    const client = new FakeTlsSocket(); server.accept(client); client.data(sipRequest().toBuffer()); await flushAsync();
    expect(create).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledWith({ host: '10.0.0.50', port: 5060 });
    proxy.disposeTransactions(); upstream.destroy(); client.destroy();
  });
});

it('uses the configured TLS DNS identity while connecting to the discovered Docker IP', async () => {
  const f = fixture(true); f.client.data(sipRequest().toBuffer()); await flushAsync();
  expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '10.0.0.50', port: 5061, servername: 'pbx.example.test', minVersion: 'TLSv1.2' }));
  const request = sipRequest({ target: 'alice@203.0.113.5', callId: 'incoming' });
  f.registrations.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: f.client.remoteAddress, clientPort: f.client.remotePort,
    transport: 'TLS', socket: f.client.asSocket(), expiresAt: Date.now() + 60000 });
  f.upstream.data(request.toBuffer()); await flushAsync(); expect(f.client.writes.at(-1)).toContain('Call-ID: incoming');
});

it('negotiates Path on TCP and enforces token integrity, device flow and expiry', async () => {
  const f = fixture(false, true);
  const unsupported = sipRequest({ method: 'REGISTER', callId: 'no-path' });
  f.client.data(unsupported.toBuffer()); await flushAsync();
  expect(f.client.writes.at(-1)).toContain('421 Extension Required');
  const register = sipRequest({ method: 'REGISTER' }); register.setHeader('Supported', 'path');
  register.setHeader('Contact', '<sip:device@phone>;+sip.instance="<urn:uuid:1234>"');
  f.client.data(register.toBuffer()); await flushAsync();
  const forwarded = new SipMessage(f.upstream.rawWrites[0]);
  expect(forwarded.getFirstHeader('Contact')).toBe(register.getFirstHeader('Contact'));
  const path = forwarded.getFirstHeader('Path')!; expect(path).toContain('transport=tcp');
  const accepted = sipResponse(forwarded); accepted.setHeader('Contact', '<sip:device@phone>;expires=600');
  f.upstream.data(accepted.toBuffer()); await flushAsync();
  expect(f.registrations.get('pbx.internal', 'alice')?.flowToken).toBeDefined();
  const attacker = new FakeTlsSocket(); attacker.remoteAddress = '198.51.100.99'; f.server.accept(attacker);
  const stolen = sipRequest({ callId: 'stolen' }); stolen.setHeader('Route', path); attacker.data(stolen.toBuffer());
  await flushAsync(); expect(attacker.writes.at(-1)).toContain('403 Forbidden'); attacker.destroy();
  const mixed = sipRequest({ target: 'device@phone', callId: 'mixed-route' });
  mixed.setHeader('Route', [path, path.replace('ft.', 'ft.other')]);
  const beforeMixed = f.client.writes.length; f.upstream.data(mixed.toBuffer()); await flushAsync();
  expect(f.client.writes).toHaveLength(beforeMixed);
  const incoming = sipRequest({ target: 'device@phone', callId: 'incoming-path' }); incoming.setHeader('Route', path);
  f.upstream.data(incoming.toBuffer()); await flushAsync();
  expect(f.client.writes.at(-1)).toContain('INVITE sip:device@phone');
  const forged = sipRequest({ target: 'device@phone', callId: 'forged' }); forged.setHeader('Route', path.replace('ft.', 'ft.bad'));
  f.upstream.data(forged.toBuffer()); await flushAsync(); expect(f.upstream.writes.at(-1)).toContain('403 Forbidden');
  f.registrations.remove('pbx.internal', 'alice');
  const expired = sipRequest({ target: 'device@phone', callId: 'expired' }); expired.setHeader('Route', path);
  f.upstream.data(expired.toBuffer()); await flushAsync(); expect(f.upstream.writes.at(-1)).toContain('430 Flow Failed');
});

it('does not release an INVITE cancelled while the stream connection is being established', async () => {
  const f = fixture();
  f.client.data(sipRequest().toBuffer());
  f.client.data(sipRequest({ method: 'CANCEL' }).toBuffer());
  await flushAsync();
  expect(f.upstream.writes).toEqual([]);
  expect(f.client.writes.some(packet => packet.includes('487 Request Terminated'))).toBe(true);
});

it('wakes a disconnected Path-registered device and delivers only after accepted re-registration', async () => {
  const f = fixture(false, true);
  const contact = '<sip:device@phone;pn-provider=fcm;pn-param=project;pn-prid=device-token>';
  const register = sipRequest({ method: 'REGISTER' }); register.setHeader('Supported', 'path'); register.setHeader('Contact', contact);
  f.client.data(register.toBuffer()); await flushAsync();
  const initial = new SipMessage(f.upstream.rawWrites[0]); const path = initial.getFirstHeader('Path')!;
  const response = sipResponse(initial); response.setHeader('Contact', `${contact};expires=600`);
  f.upstream.data(response.toBuffer()); await flushAsync(); f.client.destroy();
  const incoming = sipRequest({ target: 'device@phone', callId: 'wake-device' }); incoming.setHeader('Route', path);
  f.upstream.data(incoming.toBuffer()); await flushAsync();
  expect(f.sender.send).toHaveBeenCalledOnce();
  expect(f.upstream.writes.at(-1)).toContain('100 Trying');
  const fresh = new FakeTlsSocket(); fresh.remotePort = 5099; f.server.accept(fresh);
  const refresh = sipRequest({ method: 'REGISTER', callId: 'refresh' }); refresh.setHeader('Supported', 'path'); refresh.setHeader('Contact', contact);
  fresh.data(refresh.toBuffer()); await flushAsync();
  expect(fresh.writes).toEqual([]);
  const outgoing = new SipMessage(f.upstream.rawWrites.at(-1)!);
  const accepted = sipResponse(outgoing); accepted.setHeader('Contact', `${contact};expires=600`);
  f.upstream.data(accepted.toBuffer()); await flushAsync();
  expect(fresh.writes[0]).toContain('200 OK');
  expect(fresh.writes[1]).toContain('Call-ID: wake-device');
  fresh.destroy();
});

it('passes the configured CA bundle to upstream TLS validation without disabling authentication', async () => {
  const originalRead = fs.readFileSync;
  const ca = Buffer.from('test CA bundle');
  vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) =>
    path === '/test/pbx-ca.pem' ? ca : originalRead(path, options as BufferEncoding)) as typeof fs.readFileSync);
  const f = fixture(true, false, { SIP_TLS_CA_PATH: '/test/pbx-ca.pem', SIP_TLS_REJECT_UNAUTHORIZED: true });
  f.client.data(sipRequest().toBuffer()); await flushAsync();
  expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ ca, rejectUnauthorized: true, servername: 'pbx.example.test' }));
});
