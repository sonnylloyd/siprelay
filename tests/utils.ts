import { vi } from 'vitest';
import { Config } from '../src/configurations';
import { Logger } from '../src/logging/Logger';

export const createTestConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    SIP_UDP_PORT: 15060,
    SIP_TLS_PORT: 15061,
    HTTP_PORT: 18080,
    SIP_TLS_KEY_PATH: '/tmp/server.key',
    SIP_TLS_CERT_PATH: '/tmp/server.crt',
    PROXY_IP: '203.0.113.5',
    MEDIA_MODE: 'proxy',
    ...overrides,
  } as Config);

export const createTestLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
