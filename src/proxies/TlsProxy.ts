import tls from 'tls';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { IRecordStore } from './../store';
import { Logger } from '../logging/Logger';

export class TlsProxy extends BaseProxy {
  private config: Config;
  private server: tls.Server;

  constructor(records: IRecordStore, config: Config, logger: Logger) {
    super(records, logger);
    this.config = config;
    this.server = this.createServer();
  }

  private createServer(): tls.Server {
    return tls.createServer(
      {
        key: this.config.SIP_TLS_KEY_PATH,
        cert: this.config.SIP_TLS_CERT_PATH,
        requestCert: false,
      },
      (socket) => {
        socket.on('data', (message) => {
          const destinationHost = this.extractSipHost(message.toString());
          if (!destinationHost) return;

          const targetIp = this.getTargetIp(destinationHost);
          if (!targetIp) return;

          this.logger.info(`Forwarding TLS SIP message to ${destinationHost} -> ${targetIp}`);

          const client = tls.connect(
            {
              host: targetIp,
              port: this.config.SIP_TLS_PORT,
              rejectUnauthorized: false,
            },
            () => client.write(message)
          );

          client.on('error', (err) => this.logger.error('TLS Proxy error:', err));
        });
      }
    );
  }

  public start(): void {
    this.server.listen(this.config.SIP_TLS_PORT, '::', () => {
      this.logger.info(`TLS Proxy listening on port ${this.config.SIP_TLS_PORT} 🔐`);
    });
  }
}
