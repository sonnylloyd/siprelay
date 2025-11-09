import dotenv from 'dotenv';

dotenv.config();

export class Config {
  public readonly SIP_UDP_PORT: number = Number(process.env.SIP_UDP_PORT) || 5060;
  public readonly SIP_TLS_PORT: number = Number(process.env.SIP_TLS_PORT) || 5061;
  public readonly HTTP_PORT: number = Number(process.env.HTTP_PORT) || 8080;

  public readonly SIP_TLS_KEY_PATH: string = process.env.SIP_TLS_KEY_PATH || '/ssl/server.key';
  public readonly SIP_TLS_CERT_PATH: string = process.env.SIP_TLS_CERT_PATH || '/ssl/server.crt';

  public readonly PROXY_IP: string = process.env.PROXY_IP || '127.0.0.1';
  public readonly MEDIA_MODE: 'proxy' | 'passthrough' =
    (process.env.MEDIA_MODE as 'proxy' | 'passthrough') || 'passthrough';
}
