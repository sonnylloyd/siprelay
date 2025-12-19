import fs from 'fs';
import { Logger } from '../logging/Logger';
import { UdpProxy } from '../proxies/UdpProxy';
import { TlsProxy } from '../proxies/TlsProxy';
import { Config } from '../configurations';

export class ProxyInitializer {
  constructor(
    private readonly udpProxy: UdpProxy,
    private readonly tlsProxy: TlsProxy,
    private readonly config: Config,
    private readonly logger: Logger
  ) {}

  public start(): void {
    this.udpProxy.start();
    this.startTlsIfAvailable();
  }

  private startTlsIfAvailable(): void {
    if (fs.existsSync(this.config.SIP_TLS_KEY_PATH) && fs.existsSync(this.config.SIP_TLS_CERT_PATH)) {
      this.logger.info('TLS key and certificate found. Starting TLS proxy...');
      this.tlsProxy.start();
    } else {
      this.logger.info('TLS key and certificate not found. Skipping TLS proxy.');
    }
  }
}
