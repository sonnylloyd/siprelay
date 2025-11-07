import type { RemoteInfo } from 'dgram';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UdpProxy } from '../src/proxies/UdpProxy';
import { MemoryStore } from '../src/store';
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

const createSipResponse = (statusLine: string, callId = 'abc123'): string =>
  [
    statusLine,
    'Via: SIP/2.0/UDP 203.0.113.5:15060;branch=z9hG4bK-proxy',
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

  beforeEach(() => {
    socket = new FakeUdpSocket();
    records = new MemoryStore();
    logger = createTestLogger();
    config = createTestConfig({ SIP_UDP_PORT: 15060, PROXY_IP: '203.0.113.5' });
    proxy = new UdpProxy(records, config, logger, socket as unknown as any);
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

    const storedClient = (proxy as any).clientMap.get('abc123');
    expect(storedClient).toMatchObject({ address: '198.51.100.10', port: 5090 });
  });

  it('forwards SIP responses back to the original client', () => {
    records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5090 });
    const request = createSipRequest('pbx.internal');
    const clientInfo: RemoteInfo = { address: '198.51.100.10', port: 5090, family: 'IPv4', size: request.length };
    socket.emit('message', Buffer.from(request), clientInfo);
    (socket.send as any).mockClear();

    const response = createSipResponse('SIP/2.0 200 OK');
    const pbxInfo: RemoteInfo = { address: '10.0.0.50', port: 5090, family: 'IPv4', size: response.length };
    socket.emit('message', Buffer.from(response), pbxInfo);

    expect(socket.send).toHaveBeenCalledTimes(1);
    const [buffer, port, address] = socket.send.mock.calls[0];
    expect(address).toBe('198.51.100.10');
    expect(port).toBe(5090);
    expect(buffer.toString()).toContain('SIP/2.0/UDP 198.51.100.10:5090');
  });
});
