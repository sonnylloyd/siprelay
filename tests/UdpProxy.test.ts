import { PushSender } from '../src/push/types';
import { PushCoordinator } from '../src/push/PushCoordinator';
import { SipMessage } from '../src/sip';
import type { RemoteInfo } from 'dgram';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UdpProxy } from '../src/proxies/UdpProxy';
import { MemoryStore, RegistrationStore } from '../src/store';
import { createTestConfig, createTestLogger } from './utils';
import type { Config } from '../src/configurations';
import type { Logger } from '../src/logging/Logger';

class FakeUdpSocket {
  public bind = vi.fn((_port: number, cb?: () => void) => {
    cb?.();
  });
  public send = vi.fn((_buffer: Buffer, _port: number, _address: string) => {});
  private handlers: Record<string, (...args: any[]) => void> = {};

  public on(event: string, handler: (...args: any[]) => void): this {
    this.handlers[event] = handler;
    return this;
  }

  public emit(event: string, ...args: any[]): void {
    this.handlers[event]?.(...args);
  }
}

const createSipRequest = (host: string, callId = 'abc123'): string =>
  [
    `INVITE sip:${host} SIP/2.0`,
    'Via: SIP/2.0/UDP 198.51.100.10:5090;branch=z9hG4bK-12345;rport',
    'Max-Forwards: 70',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Contact: <sip:alice@198.51.100.10>',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

const createSipResponse = (statusLine: string, viaBranch: string, callId = 'abc123'): string =>
  [
    statusLine,
    `Via: SIP/2.0/UDP 203.0.113.5:15060;branch=${viaBranch}`,
    'Via: SIP/2.0/UDP 198.51.100.10:5090;branch=z9hG4bK-12345;rport',
    'From: <sip:alice@example.com>;tag=abc',
    'To: <sip:bob@example.com>;tag=xyz',
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

describe('UdpProxy', () => {
  let socket: FakeUdpSocket;
  let proxy: UdpProxy;
  let records: MemoryStore;
  let config: Config;
  let logger: Logger;
  let registrationStore: RegistrationStore;
  let pushSender: PushSender;

  beforeEach(() => {
    socket = new FakeUdpSocket();
    records = new MemoryStore();
    registrationStore = new RegistrationStore();
    logger = createTestLogger();
    config = createTestConfig({ SIP_UDP_PORT: 15060, PROXY_IP: '203.0.113.5' });
    pushSender = { supports: () => true, send: vi.fn().mockResolvedValue(undefined) };
    proxy = new UdpProxy(records, config, logger, registrationStore, {
      socket, pushCoordinator: new PushCoordinator(registrationStore, pushSender, logger),
    });
    proxy.start();
  });

  it('forwards SIP requests to the resolved PBX record and stores client info', () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    const sip = createSipRequest('pbx.internal');
    const clientInfo: RemoteInfo = { address: '198.51.100.10', port: 5090, family: 'IPv4', size: sip.length };

    socket.emit('message', Buffer.from(sip), clientInfo);

    expect(socket.send).toHaveBeenCalledTimes(1);
    const [buffer, port, address] = socket.send.mock.calls[0];
    expect(port).toBe(5090);
    expect(address).toBe('10.0.0.50');
    expect(buffer.toString()).toContain('SIP/2.0/UDP 203.0.113.5:15060');

    const storedClient = (proxy as any).clientMap.values().next().value;
    expect(storedClient).toMatchObject({ address: '198.51.100.10', port: 5090 });
  });

  it('forwards SIP responses back to the original client', () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    const request = createSipRequest('pbx.internal');
    const clientInfo: RemoteInfo = { address: '198.51.100.10', port: 5090, family: 'IPv4', size: request.length };
    socket.emit('message', Buffer.from(request), clientInfo);
    (socket.send as any).mockClear();

    const storedClient = (proxy as any).clientMap.values().next().value;
    const proxyBranch = storedClient?.proxyBranch as string;
    expect(proxyBranch).toBeTruthy();

    const response = createSipResponse('SIP/2.0 200 OK', proxyBranch);
    const pbxInfo: RemoteInfo = { address: '10.0.0.50', port: 5090, family: 'IPv4', size: response.length };
    socket.emit('message', Buffer.from(response), pbxInfo);

    expect(socket.send).toHaveBeenCalledTimes(1);
    const [buffer, port, address] = socket.send.mock.calls[0];
    expect(address).toBe('198.51.100.10');
    expect(port).toBe(5090);
    expect(buffer.toString()).toContain('SIP/2.0/UDP 198.51.100.10:5090');
  });
  it('keeps overlapping CSeq transactions separate and removes only its own Via', () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    const clientInfo: RemoteInfo = { address: '198.51.100.10', port: 5090, family: 'IPv4', size: 0 };
    socket.emit('message', Buffer.from(createSipRequest('pbx.internal')), clientInfo);
    socket.emit('message', Buffer.from(createSipRequest('pbx.internal').replace('CSeq: 1', 'CSeq: 2')), clientInfo);
    expect((proxy as any).clientMap.size).toBe(2);
    const forwarded = new SipMessage(socket.send.mock.calls[0][0].toString());
    const branch = forwarded.getBranchFromVia(forwarded.getTopVia()!)!;
    socket.send.mockClear();
    socket.emit('message', Buffer.from(createSipResponse('SIP/2.0 200 OK', branch)), {
      address: '10.0.0.50', port: 5090, family: 'IPv4', size: 0,
    });
    expect(socket.send).toHaveBeenCalledTimes(1);
    const response = new SipMessage(socket.send.mock.calls[0][0].toString());
    expect(response.getHeader('Via')).toHaveLength(1);
    expect(response.getTopVia()).toContain('z9hG4bK-12345');
    expect(response.getTopVia()).not.toContain(branch);
  });

  it('rejects exhausted hops without forwarding to the PBX', () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    socket.emit('message', Buffer.from(createSipRequest('pbx.internal').replace('Max-Forwards: 70', 'Max-Forwards: 0')), {
      address: '198.51.100.10', port: 5090, family: 'IPv4', size: 0,
    });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls[0][0].toString()).toContain('SIP/2.0 483 Too Many Hops');
    expect(socket.send.mock.calls[0][2]).toBe('198.51.100.10');
  });

  it('holds a PBX INVITE until a successful REGISTER moves the UDP binding', async () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    registrationStore.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: '198.51.100.10',
      clientPort: 5090, transport: 'UDP', expiresAt: Date.now() + 60000,
      push: { provider: 'fcm', app: 'our-project', token: 'secret' },
    });
    const pbx = { address: '10.0.0.50', port: 5090, family: 'IPv4', size: 0 };
    socket.emit('message', Buffer.from(createSipRequest('alice@203.0.113.5', 'incoming')), pbx);
    expect(pushSender.send).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls[0][0].toString()).toContain('100 Trying');
    const register = createSipRequest('pbx.internal', 'refresh').replaceAll('INVITE', 'REGISTER')
      .replace('To: <sip:bob@example.com>', 'To: <sip:alice@pbx.internal>')
      .replace('Contact: <sip:alice@198.51.100.10>',
        'Contact: <sip:alice@198.51.100.10;pn-provider=fcm;pn-param=our-project;pn-prid=secret>');
    socket.emit('message', Buffer.from(register), { address: '198.51.100.11', port: 55000, family: 'IPv4', size: 0 });
    const forwarded = new SipMessage(socket.send.mock.calls.at(-1)![0].toString());
    const response = createSipResponse('SIP/2.0 200 OK', forwarded.getBranchFromVia(forwarded.getTopVia()!)!, 'refresh')
      .replace('CSeq: 1 INVITE', 'CSeq: 1 REGISTER')
      .replace('Content-Length: 0', 'Contact: <sip:alice@203.0.113.5>;expires=600\r\nContent-Length: 0');
    socket.emit('message', Buffer.from(response), pbx);
    await new Promise(resolve => setImmediate(resolve));
    const delivered = socket.send.mock.calls.at(-1)!;
    expect(delivered[1]).toBe(55000);
    expect(delivered[2]).toBe('198.51.100.11');
    expect(delivered[0].toString()).toContain('Call-ID: incoming');
  });

  it('uses its loose Route to send in-dialog requests to the Docker PBX', () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    const peer = { address: '198.51.100.10', port: 5090, family: 'IPv4', size: 0 };
    socket.emit('message', Buffer.from(createSipRequest('pbx.internal')), peer);
    const invite = new SipMessage(socket.send.mock.calls[0][0].toString());
    socket.emit('message', Buffer.from(createSipResponse('SIP/2.0 200 OK', invite.getBranchFromVia(invite.getTopVia()!)!)),
      { address: '10.0.0.50', port: 5090 });
    socket.send.mockClear();
    const request = new SipMessage(createSipRequest('asterisk@10.0.0.50'));
    request.setHeader('To', '<sip:bob@example.com>;tag=xyz');
    request.startLine = 'BYE sip:asterisk@10.0.0.50 SIP/2.0';
    request.setHeader('CSeq', '2 BYE');
    request.setHeader('Route', '<sip:203.0.113.5:15060;transport=udp;lr;sr-domain=pbx.internal>');
    socket.emit('message', Buffer.from(request.toString()), { address: '198.51.100.10', port: 5090, family: 'IPv4', size: 0 });
    expect(socket.send.mock.calls[0][2]).toBe('10.0.0.50');
    const forwarded = new SipMessage(socket.send.mock.calls[0][0].toString());
    expect(forwarded.getHeader('Route')).toHaveLength(0);
    expect(forwarded.getHeader('Record-Route')).toHaveLength(0);
  });

  it('drops malformed datagrams without forwarding or throwing', () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    const request = createSipRequest('pbx.internal').replace('Content-Length: 0', ': invalid\r\nContent-Length: 0');
    expect(() => socket.emit('message', Buffer.from(request), { address: '198.51.100.10', port: 5090 })).not.toThrow();
    expect(socket.send).not.toHaveBeenCalled();
  });

});
