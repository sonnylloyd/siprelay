// UdpProxy.ts
import dgram from 'dgram';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { Logger } from '../logging/Logger';
import { IPValue, IRecordStore } from './../store';

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

      if (this.isResponse(sipMessage)) {
        this.handleSipResponse(sipMessage, callId);
      } else {
        this.handleSipRequest(sipMessage, callId, rinfo);
      }
    });

    this.udpSocket.bind(this.config.SIP_UDP_PORT, () => {
      this.logger.info(`SIP UDP Proxy listening on port ${this.config.SIP_UDP_PORT}`);
    });
  }

  private handleSipRequest(sipMessage: string, callId: string | null, rinfo: dgram.RemoteInfo): void {
    const destinationHost = this.extractSipHost(sipMessage);
    if (!destinationHost) {
      this.logger.warn(`Failed to extract SIP destination from message`);
      return;
    }

    const record:IPValue|null = this.getTargetRecord(destinationHost);
    if (!record || !record.udpPort) {
      this.logger.warn(`No UDP route found for SIP host: ${destinationHost}`);
      return;
    }

    if (callId) {
      this.storeClient(callId, rinfo.address, rinfo.port);
    }

    let modifiedMessage = this.addViaHeader(sipMessage, this.config.PROXY_IP, this.config.SIP_UDP_PORT, 'UDP');
    modifiedMessage = this.rewriteContactHeader(modifiedMessage, this.config.PROXY_IP, this.config.SIP_UDP_PORT);
    modifiedMessage = this.rewriteSdpBody(modifiedMessage, this.config.PROXY_IP);

    this.logger.info(`Forwarding SIP request to PBX ${record.ip}`);
    this.udpSocket.send(Buffer.from(modifiedMessage), record.udpPort, record.ip);
  }

  private handleSipResponse(sipMessage: string, callId: string | null): void {
    if (!callId) {
      this.logger.warn(`No Call-ID found in SIP response.`);
      return;
    }

    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      this.logger.warn(`No client info found for Call-ID ${callId}`);
      return;
    }

    this.removeClientOn2xx(callId, sipMessage);

    let modifiedMessage = this.removeViaHeader(sipMessage, callId, 'UDP');
    modifiedMessage = this.rewriteSdpBody(modifiedMessage, this.config.PROXY_IP);

    this.logger.info(`Forwarding SIP response to client at ${clientInfo.address}:${clientInfo.port}`);
    this.udpSocket.send(Buffer.from(modifiedMessage), clientInfo.port, clientInfo.address);
  }
}