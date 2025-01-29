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
      const callId = this.extractCallId(sipMessage);

      if (!callId) {
        this.logger.warn(`Received SIP message without Call-ID from ${rinfo.address}:${rinfo.port}`);
        return;
      }

      const clientInfo = this.getClient(callId);

      if (clientInfo) {
        // 🔄 This is a SIP RESPONSE → Relay back to original sender
        this.logger.info(`Relaying SIP response (Call-ID: ${callId}) from ${rinfo.address} to ${clientInfo.address}:${clientInfo.port}`);

        this.udpSocket.send(message, clientInfo.port, clientInfo.address, (err) => {
          if (err) this.logger.error(`Error relaying SIP response:`, err);
        });

        // Optionally remove after response (if SIP session tracking is not needed long-term)
        this.removeClient(callId);
      } else {
        // 📤 This is a SIP REQUEST → Forward to the destination server
        const destinationHost = this.extractSipHost(sipMessage, 'UDP');
        if (!destinationHost) {
          this.logger.warn(`Failed to extract SIP destination from Call-ID: ${callId}`);
          return;
        }

        const targetIp = this.getTargetIp(destinationHost);
        if (!targetIp) {
          this.logger.warn(`No IP found for SIP host: ${destinationHost}`);
          return;
        }

        this.logger.info(`Forwarding SIP message (Call-ID: ${callId}) from ${rinfo.address}:${rinfo.port} to ${targetIp}`);

        // Store sender info for response routing
        this.storeClient(callId, rinfo.address, rinfo.port);

        this.udpSocket.send(message, this.config.SIP_UDP_PORT, targetIp, (err) => {
          if (err) this.logger.error(`Error forwarding SIP message to ${targetIp}:`, err);
        });
      }
    });

    this.udpSocket.bind(this.config.SIP_UDP_PORT, () => {
      this.logger.info(`SIP UDP Proxy listening on port ${this.config.SIP_UDP_PORT} 📡`);
    });
  }
}
