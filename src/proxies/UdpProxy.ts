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
      
      if (this.isResponse(sipMessage)) {
        this.handleResponse(sipMessage, message);
      } else {
        this.handleRequest(sipMessage, message, rinfo);
      }
    });

    this.udpSocket.bind(this.config.SIP_UDP_PORT, () => {
      this.logger.info(`SIP UDP Proxy listening on port ${this.config.SIP_UDP_PORT} 📡`);
    });
  }

  private handleRequest(sipMessage: string, rawMessage: Buffer, rinfo: dgram.RemoteInfo): void {
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

    const callId = this.extractCallId(sipMessage);
    if (callId) {
      this.storeClient(callId, rinfo.address, rinfo.port);
    }

    const modifiedMessage = this.addViaHeader(sipMessage, this.config.PROXY_IP, this.config.SIP_UDP_PORT);
    
    this.logger.info(`Forwarding SIP request from ${rinfo.address}:${rinfo.port} to ${targetIp}`);
    this.udpSocket.send(Buffer.from(modifiedMessage), this.config.SIP_UDP_PORT, targetIp, (err) => {
      if (err) this.logger.error(`Error forwarding SIP message to ${targetIp}:`, err);
    });
  }

  private handleResponse(sipMessage: string, rawMessage: Buffer): void {
    const callId = this.extractCallId(sipMessage);
    if (!callId) {
      this.logger.warn(`No matching client found for response: ${sipMessage}`);
      return;
    }

    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      return;
    }
    this.removeClient(callId);

    const modifiedMessage = this.removeViaHeader(sipMessage, callId);
    
    this.logger.info(`Forwarding SIP response to ${clientInfo.address}:${clientInfo.port}`);
    this.udpSocket.send(Buffer.from(modifiedMessage), clientInfo.port, clientInfo.address, (err) => {
      if (err) this.logger.error(`Error sending response to client ${clientInfo.address}:${clientInfo.port}:`, err);
    });
  }
}
