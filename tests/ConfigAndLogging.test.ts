import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/configurations';
import { ConsoleLogger } from '../src/logging';

const configKeys = ['SIP_UDP_PORT', 'SIP_TLS_PORT', 'HTTP_PORT', 'HTTP_CORS_ORIGINS', 'SIP_TLS_KEY_PATH', 'SIP_TLS_CERT_PATH',
  'SIP_TLS_REJECT_UNAUTHORIZED', 'PROXY_IP', 'MEDIA_MODE', 'PUSH_APNS_KEY_PATH', 'PUSH_APNS_KEY_ID', 'PUSH_APNS_TEAM_ID',
  'PUSH_APNS_TOPIC', 'PUSH_APNS_SANDBOX', 'PUSH_FCM_SERVICE_ACCOUNT_PATH'];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('configuration', () => {
  it('uses safe documented defaults with optional push disabled', () => {
    configKeys.forEach(key => vi.stubEnv(key, ''));
    const config = new Config();
    expect(config).toMatchObject({ SIP_UDP_PORT: 5060, SIP_TLS_PORT: 5061, HTTP_PORT: 8080,
      HTTP_CORS_ORIGINS: [], SIP_TLS_KEY_PATH: '/ssl/server.key', SIP_TLS_CERT_PATH: '/ssl/server.crt',
      SIP_TLS_REJECT_UNAUTHORIZED: true, PROXY_IP: '127.0.0.1', MEDIA_MODE: 'passthrough',
      PUSH_APNS_KEY_PATH: '', PUSH_APNS_KEY_ID: '', PUSH_APNS_TEAM_ID: '', PUSH_APNS_TOPIC: '',
      PUSH_APNS_SANDBOX: false, PUSH_FCM_SERVICE_ACCOUNT_PATH: '' });
  });

  it('reads explicit ports, trimmed CORS origins, credentials and TLS flags', () => {
    const overrides = { SIP_UDP_PORT: '15060', SIP_TLS_PORT: '15061', HTTP_PORT: '18080',
      HTTP_CORS_ORIGINS: ' https://one.example, ,https://two.example ', SIP_TLS_KEY_PATH: '/key', SIP_TLS_CERT_PATH: '/cert',
      SIP_TLS_REJECT_UNAUTHORIZED: '0', PROXY_IP: 'relay.example', MEDIA_MODE: 'passthrough',
      PUSH_APNS_KEY_PATH: '/push-key', PUSH_APNS_KEY_ID: 'KEY', PUSH_APNS_TEAM_ID: 'TEAM', PUSH_APNS_TOPIC: 'app.voip',
      PUSH_APNS_SANDBOX: '1', PUSH_FCM_SERVICE_ACCOUNT_PATH: '/service-account' };
    Object.entries(overrides).forEach(([key, value]) => vi.stubEnv(key, value));
    expect(new Config()).toMatchObject({ SIP_UDP_PORT: 15060, SIP_TLS_PORT: 15061, HTTP_PORT: 18080,
      HTTP_CORS_ORIGINS: ['https://one.example', 'https://two.example'], SIP_TLS_REJECT_UNAUTHORIZED: false,
      PUSH_APNS_SANDBOX: true, PUSH_APNS_KEY_PATH: '/push-key', PUSH_FCM_SERVICE_ACCOUNT_PATH: '/service-account',
      SIP_TLS_KEY_PATH: '/key', SIP_TLS_CERT_PATH: '/cert', PROXY_IP: 'relay.example' });
  });

  it('does not disable certificate verification for values other than explicit zero', () => {
    vi.stubEnv('MEDIA_MODE', 'passthrough'); vi.stubEnv('SIP_TLS_REJECT_UNAUTHORIZED', 'false');
    expect(new Config().SIP_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });
});

describe('console logging', () => {
  it.each([
    ['error', [false, false, false, true]], ['warn', [false, false, true, true]],
    ['info', [false, true, true, true]], ['debug', [true, true, true, true]],
  ])('filters messages at %s level', (level, expected) => {
    vi.stubEnv('LOG_LEVEL', level);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new ConsoleLogger();
    logger.debug('debug'); logger.info('info'); logger.warn('warn'); logger.error('error');
    [debug, info, warn, error].forEach((method, index) => expect(method.mock.calls.length > 0).toBe(expected[index]));
  });

  it('falls back for unknown levels and preserves error metadata', () => {
    vi.stubEnv('LOG_LEVEL', 'unknown');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const metadata = new Error('failure'); const logger = new ConsoleLogger(); logger.info('ready'); logger.error('failed', metadata);
    expect(log).toHaveBeenCalledWith('[INFO] ready', ''); expect(error).toHaveBeenCalledWith('[ERROR] failed', metadata);
  });
});

it('preserves TLS-only deployments while allowing explicit TCP enablement independently of UDP', () => {
  vi.stubEnv('SIP_TCP_ENABLED', undefined); vi.stubEnv('SIP_UDP_ENABLED', '0');
  expect(new Config().SIP_TCP_ENABLED).toBe(false);
  vi.stubEnv('SIP_TCP_ENABLED', '1'); expect(new Config().SIP_TCP_ENABLED).toBe(true);
  vi.stubEnv('SIP_UDP_ENABLED', '1'); vi.stubEnv('SIP_TCP_ENABLED', '0');
  expect(new Config().SIP_TCP_ENABLED).toBe(false);
});
