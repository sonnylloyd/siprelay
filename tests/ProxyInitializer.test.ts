import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyInitializer } from '../src/bootstrap/ProxyInitializer';
import { Config } from '../src/configurations';
import { createTestConfig, createTestLogger } from './utils';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('proxy initialization', () => {
  it('starts UDP without constructing TLS when certificates are absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const udp = { start: vi.fn() }, tlsFactory = vi.fn();
    new ProxyInitializer(udp, tlsFactory, createTestConfig(), createTestLogger()).start();
    expect(udp.start).toHaveBeenCalledTimes(1);
    expect(tlsFactory).not.toHaveBeenCalled();
  });

  it('constructs and starts TLS when both certificates are present', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const tls = { start: vi.fn() };
    new ProxyInitializer({ start: vi.fn() }, () => tls, createTestConfig(), createTestLogger()).start();
    expect(tls.start).toHaveBeenCalledTimes(1);
  });

  it('supports TLS-only operation without opening the UDP listener', () => {
    vi.stubEnv('SIP_UDP_ENABLED', '0');
    expect(new Config().SIP_UDP_ENABLED).toBe(false);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const udp = { start: vi.fn() }, tls = { start: vi.fn() };
    new ProxyInitializer(udp, () => tls, createTestConfig({ SIP_UDP_ENABLED: false }), createTestLogger()).start();
    expect(udp.start).not.toHaveBeenCalled(); expect(tls.start).toHaveBeenCalledOnce();
  });

  it('rejects media rewriting without an RTP relay', () => {
    vi.stubEnv('MEDIA_MODE', 'proxy');
    expect(() => new Config()).toThrow('does not relay RTP');
  });
});

it('starts plain TCP independently of TLS credentials and honors its disable switch', () => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(false); const tcp = { start: vi.fn() };
  new ProxyInitializer({ start: vi.fn() }, vi.fn(), createTestConfig({ SIP_TCP_ENABLED: true }), createTestLogger(), () => tcp).start();
  expect(tcp.start).toHaveBeenCalledOnce();
  new ProxyInitializer({ start: vi.fn() }, vi.fn(), createTestConfig({ SIP_TCP_ENABLED: false }), createTestLogger(), () => tcp).start();
  expect(tcp.start).toHaveBeenCalledOnce();
});
