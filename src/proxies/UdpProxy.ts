import dgram from 'dgram';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { Logger } from '../logging/Logger';
import { IRecordStore } from './../store';

export class UdpProxy extends BaseProxy {
  private config: Config;
  private udpSocket: dgram.Socket;

  constructor(records: IRecordStore, config: Config, logger: Logger) {
    super(records, logger);
    this.config = config;
    this.udpSocket = dgram.createSocket('udp6');
  }

  public start(): void {
    this.udpSocket.on('message', (message, rinfo) => {
      const destinationHost = this.extractSipHost(message.toString(), 'UDP');
      if (!destinationHost) return;

      const targetIp = this.getTargetIp(destinationHost);
      if (!targetIp) return;

      this.logger.info(`Forwarding UDP SIP message to ${destinationHost} -> ${targetIp}`);

      this.udpSocket.send(message, this.config.SIP_UDP_PORT, targetIp, (err) => {
        if (err) this.logger.error(`UDP Proxy error forwarding to ${targetIp}:`, err);
      });
    });

    this.udpSocket.bind(this.config.SIP_UDP_PORT, '::', () => {
      this.logger.info(`UDP Proxy listening on port ${this.config.SIP_UDP_PORT} 📡`);
    });
  }
}
