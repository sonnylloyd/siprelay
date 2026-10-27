import fs from 'fs';
import { Logger } from '../logging/Logger';
import { Proxy } from '../proxies/Proxy';
import { Config } from '../configurations';

export class ProxyInitializer {
  constructor(
    private readonly udpProxy: Proxy,
    private readonly tlsProxy: () => Proxy,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly tcpProxy?: () => Proxy
  ) {}

  public start(): void {
    if (this.config.SIP_UDP_ENABLED !== false) this.udpProxy.start();
    if (this.config.SIP_TCP_ENABLED !== false) this.tcpProxy?.().start();
    this.startTlsIfAvailable();
  }

  private startTlsIfAvailable(): void {
    if (fs.existsSync(this.config.SIP_TLS_KEY_PATH) && fs.existsSync(this.config.SIP_TLS_CERT_PATH)) {
      this.logger.info('TLS key and certificate found. Starting TLS proxy...');
      this.tlsProxy().start();
    } else {
      this.logger.info('TLS key and certificate not found. Skipping TLS proxy.');
    }
  }
}
