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
    this.udpSocket = dgram.createSocket('udp4');
  }

  public start(): void {
    this.udpSocket.on('message', (message, rinfo) => {
      const sipMessage = message.toString();
      const destinationHost = this.extractSipHost(sipMessage);

      if (!destinationHost) {
        this.logger.warn(`Failed to extract SIP destination from message: ${sipMessage}`);
        return;
      }

      const targetIp = this.getTargetIp(destinationHost);
      if (!targetIp) {
        this.logger.warn(`No IP found for SIP host: ${destinationHost}`);
        return;
      }

      this.logger.info(`Forwarding SIP message from ${rinfo.address}:${rinfo.port} to ${targetIp}`);

      // Forward the SIP message to the target PBX
      this.udpSocket.send(message, this.config.SIP_UDP_PORT, targetIp, (err) => {
        if (err) this.logger.error(`Error forwarding SIP message to ${targetIp}:`, err);
      });
    });

    this.udpSocket.bind(this.config.SIP_UDP_PORT, () => {
      this.logger.info(`SIP UDP Proxy listening on port ${this.config.SIP_UDP_PORT} 📡`);
    });
  }
}