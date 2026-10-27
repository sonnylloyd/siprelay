import dgram from 'dgram';
import express, { Request, Response } from 'express';
import fs from 'fs';
import tls from 'tls';
import net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTlsServer } from './fixtures/transports';
import { sipRequest, flushAsync } from './fixtures/sip';

// Exercise the actual composition root without opening a socket or requiring a Docker daemon.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('application dependency wiring', () => {
  it('starts UDP with missing certificates and routes through the same Docker-managed store', async () => {
    vi.stubEnv('PUSH_STORAGE', 'memory');
    vi.stubEnv('SIP_TCP_ENABLED', '0');
    vi.stubEnv('MEDIA_MODE', 'passthrough'); vi.stubEnv('HTTP_CORS_ORIGINS', '');
    vi.stubEnv('PUSH_APNS_KEY_PATH', ''); vi.stubEnv('PUSH_FCM_SERVICE_ACCOUNT_PATH', '');
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      on: vi.fn((event: string, callback: (...args: unknown[]) => void) => { handlers.set(event, callback); }),
      bind: vi.fn((_port: number, callback: () => void) => { callback(); }),
      send: vi.fn(),
    };
    vi.spyOn(dgram, 'createSocket').mockReturnValue(socket as unknown as dgram.Socket);
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const createTls = vi.spyOn(tls, 'createServer');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const use = vi.spyOn(express.application, 'use');
    const { container } = await import('../src/container');
    const records = container.resolve('records');
    records.addRecord('pbx.internal', { ip: '10.0.0.1', udpPort: 5060 });
    await container.resolve('registrationStore').initialize();
    container.resolve('proxyInitializer').start();
    expect(createTls).not.toHaveBeenCalled(); expect(socket.bind).toHaveBeenCalledTimes(1);
    handlers.get('message')!(Buffer.from(sipRequest().toString()), { address: '198.51.100.10', port: 5090 });
    expect(socket.send).toHaveBeenCalledWith(expect.any(Buffer), 5060, '10.0.0.1');
    expect(container.resolve('records')).toBe(records);
    expect(container.resolve('serviceWatcher')).toHaveProperty('watch');
    expect(container.resolve('apiServer')).toHaveProperty('start');
    const router = use.mock.calls.find(call => call[0] === '/api')![1] as express.Router;
    const status = vi.fn().mockReturnThis();
    router({ method: 'GET', url: '/ready', headers: {} } as Request, { status, json: vi.fn() } as unknown as Response, vi.fn());
    expect(status).toHaveBeenCalledWith(200);
    container.resolve('pushCoordinator').dispose(); await container.resolve('registrationStore').close();
  }, 15_000);

  it('constructs TCP and TLS when enabled and shares accepted registrations', async () => {
    vi.stubEnv('PUSH_STORAGE', 'memory');
    vi.stubEnv('SIP_TCP_ENABLED', '1');
    const createTcp = vi.spyOn(net, 'createServer').mockReturnValue(new FakeTlsServer(() => {}).asServer());
    vi.stubEnv('MEDIA_MODE', 'passthrough'); vi.stubEnv('PUSH_APNS_KEY_PATH', ''); vi.stubEnv('PUSH_FCM_SERVICE_ACCOUNT_PATH', '');
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path === '/ssl/server.key' || path === '/ssl/server.crt') return Buffer.from('credential');
      return originalRead(path, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(dgram, 'createSocket').mockReturnValue({ on: vi.fn(), bind: vi.fn() } as unknown as dgram.Socket);
    const createServer = vi.spyOn(tls, 'createServer').mockImplementation(((_options: tls.TlsOptions, listener: (socket: tls.TLSSocket) => void) =>
      new FakeTlsServer(listener).asServer()) as typeof tls.createServer);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { container } = await import('../src/container');
    await container.resolve('registrationStore').initialize();
    container.resolve('proxyInitializer').start();
    expect(createServer).toHaveBeenCalledTimes(1); expect(createTcp).toHaveBeenCalledOnce();
    container.resolve('tcpProxy').disposeTransactions();
    expect(container.resolve('tlsProxy')).toBe(container.resolve('tlsProxy'));
    await flushAsync(); container.resolve('pushCoordinator').dispose(); await container.resolve('registrationStore').close();
  }, 15_000);
});
