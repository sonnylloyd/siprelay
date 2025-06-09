// UdpProxy.ts
import dgram from 'dgram';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { Logger } from '../logging/Logger';
import { IPValue, IRecordStore } from './../store';
import { SipMessage } from '../sip/SipMessage';

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
      const rawMessage = message.toString();
      const sipMsg = new SipMessage(rawMessage);
      const callId = sipMsg.getCallId();

      if (sipMsg.isResponse()) {
        this.handleSipResponse(sipMsg, callId);
      } else {
        this.handleSipRequest(sipMsg, callId, rinfo);
      }
    });

    this.udpSocket.bind(this.config.SIP_UDP_PORT, () => {
      this.logger.info(`SIP UDP Proxy listening on port ${this.config.SIP_UDP_PORT}`);
    });
  }

  private handleSipRequest(sipMsg: SipMessage, callId: string | undefined, rinfo: dgram.RemoteInfo): void {
    const destinationHost = sipMsg.getTargetHost();
    console.log(destinationHost);
    if (!destinationHost) {
      this.logger.warn(`Failed to extract SIP destination from message`);
      return;
    }

    const record: IPValue | null = this.getTargetRecord(destinationHost);
    if (!record || !record.udpPort) {
      this.logger.warn(`No UDP route found for SIP host: ${destinationHost}`);
      return;
    }

    if (callId) {
      this.storeClient(callId, rinfo.address, rinfo.port, sipMsg.toString());
    }

    sipMsg.addViaTop(`SIP/2.0/UDP ${this.config.PROXY_IP}:${this.config.SIP_UDP_PORT};branch=${sipMsg.generateBranch()}`);
    sipMsg.updateContact(this.config.PROXY_IP, this.config.SIP_UDP_PORT);
    sipMsg.updateSdpIp(this.config.PROXY_IP);

    this.logger.info(`Forwarding SIP request to PBX ${record.ip}`);
    this.udpSocket.send(Buffer.from(sipMsg.toString()), record.udpPort, record.ip);
  }

  private handleSipResponse(sipMsg: SipMessage, callId: string | undefined): void {
    if (!callId) {
      this.logger.warn(`No Call-ID found in SIP response.`);
      return;
    }

    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      this.logger.warn(`No client info found for Call-ID ${callId}`);
      return;
    }

    this.removeClientOn2xx(callId, sipMsg.toString());

    const newVia = `SIP/2.0/UDP ${clientInfo.address}:${clientInfo.port}` +
      (clientInfo.branch ? `;branch=${clientInfo.branch}` : '') +
      (clientInfo.rport ? `;rport` : '');

    sipMsg.replaceViaTop(newVia);
    sipMsg.updateSdpIp(this.config.PROXY_IP);

    this.logger.info(`Forwarding SIP response to client at ${clientInfo.address}:${clientInfo.port}`);
    this.udpSocket.send(Buffer.from(sipMsg.toString()), clientInfo.port, clientInfo.address);
  }
}