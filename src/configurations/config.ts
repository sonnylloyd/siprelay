import dotenv from 'dotenv';

dotenv.config();

export class Config {
  public readonly SIP_UDP_PORT: number = Number(process.env.SIP_UDP_PORT) || 5060;
  public readonly SIP_TLS_PORT: number = Number(process.env.SIP_TLS_PORT) || 5061;
  public readonly HTTP_PORT: number = Number(process.env.HTTP_PORT) || 8080;

  public readonly SIP_TLS_KEY_PATH: string = process.env.SIP_TLS_KEY_PATH || '/ssl/server.key';
  public readonly SIP_TLS_CERT_PATH: string = process.env.SIP_TLS_CERT_PATH || '/ssl/server.crt';
}