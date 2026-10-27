import dotenv from 'dotenv';
import { isIP } from 'node:net';

dotenv.config();

export class Config {
  public readonly PUSH_STORAGE = readPushStorage();
  public readonly PUSH_SQLITE_PATH = readSqlitePath();
  public readonly PUSH_MYSQL_HOST = readMysqlHost();
  public readonly PUSH_MYSQL_PORT = readMysqlPort();
  public readonly PUSH_MYSQL_DATABASE = process.env.PUSH_MYSQL_DATABASE || 'siprelay';
  public readonly PUSH_MYSQL_USER = process.env.PUSH_MYSQL_USER || 'siprelay';
  public readonly PUSH_MYSQL_PASSWORD = process.env.PUSH_MYSQL_PASSWORD || '';
  public readonly PUSH_MYSQL_TLS = process.env.PUSH_MYSQL_TLS !== '0';
  public readonly PUSH_MYSQL_CA_PATH = process.env.PUSH_MYSQL_CA_PATH || '';
  public readonly SIP_REGISTRATION_MODE: 'path' | 'contact' = readRegistrationMode();
  // Preserve existing TLS-only deployments when adding the TCP listener.
  public readonly SIP_TCP_ENABLED = (process.env.SIP_TCP_ENABLED ?? process.env.SIP_UDP_ENABLED) !== '0';
  public readonly SIP_TCP_PORT = Number(process.env.SIP_TCP_PORT) || 5060;
  public readonly SIP_UDP_ENABLED = process.env.SIP_UDP_ENABLED !== '0';
  public readonly SIP_UDP_PORT: number = Number(process.env.SIP_UDP_PORT) || 5060;
  public readonly SIP_TLS_PORT: number = Number(process.env.SIP_TLS_PORT) || 5061;
  public readonly HTTP_PORT: number = Number(process.env.HTTP_PORT) || 8080;
  public readonly HTTP_CORS_ORIGINS: string[] = (process.env.HTTP_CORS_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  public readonly SIP_TLS_CA_PATH = process.env.SIP_TLS_CA_PATH || '';
  public readonly SIP_TLS_KEY_PATH: string = process.env.SIP_TLS_KEY_PATH || '/ssl/server.key';
  public readonly SIP_TLS_CERT_PATH: string = process.env.SIP_TLS_CERT_PATH || '/ssl/server.crt';
  public readonly SIP_TLS_REJECT_UNAUTHORIZED: boolean =
    process.env.SIP_TLS_REJECT_UNAUTHORIZED === '0' ? false : true;

  public readonly PUSH_APNS_KEY_PATH = process.env.PUSH_APNS_KEY_PATH || '';
  public readonly PUSH_APNS_KEY_ID = process.env.PUSH_APNS_KEY_ID || '';
  public readonly PUSH_APNS_TEAM_ID = process.env.PUSH_APNS_TEAM_ID || '';
  public readonly PUSH_APNS_TOPIC = process.env.PUSH_APNS_TOPIC || '';
  public readonly PUSH_APNS_SANDBOX = process.env.PUSH_APNS_SANDBOX === '1';
  public readonly PUSH_FCM_SERVICE_ACCOUNT_PATH = process.env.PUSH_FCM_SERVICE_ACCOUNT_PATH || '';

  public readonly PROXY_IP: string = process.env.PROXY_IP || '127.0.0.1';
  public readonly MEDIA_MODE = readMediaMode();
}

function readPushStorage(): 'memory' | 'sqlite' | 'mysql' {
  const backend = process.env.PUSH_STORAGE ?? 'memory';
  if (backend !== 'memory' && backend !== 'sqlite' && backend !== 'mysql') throw new Error('PUSH_STORAGE must be memory, sqlite or mysql');
  return backend;
}

function readMysqlPort(): number {
  const port = Number(process.env.PUSH_MYSQL_PORT ?? 3306);
  if (process.env.PUSH_STORAGE === 'mysql' && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('PUSH_MYSQL_PORT must be a valid port');
  return port;
}

function readMediaMode(): 'passthrough' {
  if (process.env.MEDIA_MODE && process.env.MEDIA_MODE !== 'passthrough') {
    throw new Error('Only MEDIA_MODE=passthrough is supported; SIPRelay does not relay RTP');
  }
  return 'passthrough';
}

function readRegistrationMode(): 'path' | 'contact' {
  const mode = process.env.SIP_REGISTRATION_MODE ?? 'path';
  if (mode !== 'path' && mode !== 'contact') throw new Error('SIP_REGISTRATION_MODE must be path or contact');
  return mode;
}

function readSqlitePath(): string {
  const filename = process.env.PUSH_SQLITE_PATH || '/data/push.sqlite';
  if (process.env.PUSH_STORAGE === 'sqlite' && filename === ':memory:') throw new Error('PUSH_SQLITE_PATH must name a persistent file; select PUSH_STORAGE=memory for volatile storage');
  return filename;
}

function readMysqlHost(): string {
  const host = process.env.PUSH_MYSQL_HOST || 'localhost';
  // mysql2 enables certificate identity checks using DNS SNI; reject ambiguous IP-only TLS.
  if (process.env.PUSH_STORAGE === 'mysql' && process.env.PUSH_MYSQL_TLS !== '0' && isIP(host)) {
    throw new Error('PUSH_MYSQL_HOST must be a DNS hostname when MySQL TLS is enabled');
  }
  return host;
}
