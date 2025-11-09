// UdpProxy.ts
import dgram from 'dgram';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { Logger } from '../logging/Logger';
import { IPValue, IRecordStore, RegistrationStore } from './../store';
import { SipMessage } from '../sip/SipMessage';

export class UdpProxy extends BaseProxy {
  private config: Config;
  private udpSocket: dgram.Socket;

  constructor(
    records: IRecordStore,
    config: Config,
    logger: Logger,
    registrationStore: RegistrationStore,
    socket?: dgram.Socket
  ) {
    super(records, logger, registrationStore, {
      mediaPassthrough: config.MEDIA_MODE === 'passthrough',
    });
    this.config = config;
    this.udpSocket = socket ?? dgram.createSocket('udp4');
  }

  public start(): void {
    this.udpSocket.on('error', (err) => {
      this.logger.error('SIP UDP socket error', err);
    });

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

  private handleSipRequest(
    sipMsg: SipMessage,
    callId: string | undefined,
    rinfo: dgram.RemoteInfo
  ): void {
    const method = sipMsg.getMethod();
    if (method === 'REGISTER') {
      this.handleRegistrationBinding(sipMsg, rinfo);
    }

    const destinationHost = sipMsg.getTargetHost();
    if (this.isRequestTargetingProxy(destinationHost)) {
      this.forwardRequestToRegisteredClient(sipMsg, rinfo);
      return;
    }

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
      this.storeClient(callId, rinfo.address, rinfo.port, { sipMessage: sipMsg });
    }

    const branch = this.addProxyHeaders(sipMsg, 'UDP', this.config.PROXY_IP, this.config.SIP_UDP_PORT);

    this.logger.info(`Forwarding SIP request to PBX ${record.ip} (branch ${branch})`);
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

    this.prepareSipResponseForClient(sipMsg, clientInfo, 'UDP', this.config.PROXY_IP);

    this.logger.info(`Forwarding SIP response to client at ${clientInfo.address}:${clientInfo.port}`);
    this.udpSocket.send(Buffer.from(sipMsg.toString()), clientInfo.port, clientInfo.address);
  }

  private handleRegistrationBinding(sipMsg: SipMessage, rinfo: dgram.RemoteInfo): void {
    const aor = sipMsg.getAddressOfRecord();
    const domain = aor?.host ?? sipMsg.getTargetHost();
    const user = aor?.user ?? sipMsg.getTargetUser();

    if (!domain || !user) {
      this.logger.warn('Unable to extract AoR from REGISTER request');
      return;
    }

    const expires = this.getRegistrationExpiry(sipMsg);
    if (expires === null) return;

    if (expires === 0) {
      const removed = this.registrationStore.remove(domain, user);
      if (removed) {
        this.logger.info(`Removed registration for ${user}@${domain}`);
      }
      return;
    }

    const contact = sipMsg.getContactHeaders()[0];
    this.registrationStore.upsert({
      domain,
      user,
      clientAddress: rinfo.address,
      clientPort: rinfo.port,
      contact,
      expiresAt: Date.now() + expires * 1000,
    });

    this.logger.info(
      `Stored registration for ${user}@${domain} via ${rinfo.address}:${rinfo.port} (expires in ${expires}s)`
    );
  }

  private getRegistrationExpiry(sipMsg: SipMessage): number | null {
    const contactHeaders = sipMsg.getContactHeaders();
    for (const header of contactHeaders) {
      if (header.includes('*')) {
        const expiresHeader = this.extractExpiresHeader(sipMsg);
        return expiresHeader ?? 0;
      }
      const match = header.match(/;expires=(\d+)/i);
      if (match) {
        const value = Number.parseInt(match[1], 10);
        if (!Number.isNaN(value)) return value;
      }
    }

    const globalExpires = this.extractExpiresHeader(sipMsg);
    if (globalExpires !== null) return globalExpires;
    return 3600;
  }

  private extractExpiresHeader(sipMsg: SipMessage): number | null {
    const expiresHeader = sipMsg.getFirstHeader('Expires');
    if (!expiresHeader) return null;
    const value = Number.parseInt(expiresHeader, 10);
    return Number.isNaN(value) ? null : value;
  }

  private isRequestTargetingProxy(targetHost: string | null): boolean {
    if (!targetHost) return false;
    const [hostOnly] = targetHost.split(':');
    return hostOnly === this.config.PROXY_IP;
  }

  private forwardRequestToRegisteredClient(sipMsg: SipMessage, rinfo: dgram.RemoteInfo): void {
    const targetUser = sipMsg.getTargetUser();
    if (!targetUser) {
      this.logger.warn('Failed to determine target user for PBX request');
      return;
    }

    const domain = this.records.findHostnameByIp(rinfo.address);
    if (!domain) {
      this.logger.warn(`No PBX record found for source IP ${rinfo.address}`);
      return;
    }

    this.registrationStore.purgeExpired();
    const binding = this.registrationStore.get(domain, targetUser);
    if (!binding) {
      this.logger.warn(`No registration binding for ${targetUser}@${domain}`);
      return;
    }

    const branch = sipMsg.generateBranch();
    sipMsg.addViaTop(`SIP/2.0/UDP ${this.config.PROXY_IP}:${this.config.SIP_UDP_PORT};branch=${branch}`);

    if (sipMsg.getCallId()) {
      this.storeClient(sipMsg.getCallId()!, rinfo.address, rinfo.port, { sipMessage: sipMsg });
    }

    this.logger.info(
      `Forwarding PBX request for ${targetUser}@${domain} to ${binding.clientAddress}:${binding.clientPort}`
    );
    this.udpSocket.send(Buffer.from(sipMsg.toString()), binding.clientPort, binding.clientAddress);
  }
}
