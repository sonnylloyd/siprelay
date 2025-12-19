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
  private pendingRegistrations: Map<
    string,
    {
      domain: string;
      user: string;
      clientAddress: string;
      clientPort: number;
      contact?: string;
      timeout: NodeJS.Timeout;
    }
  >;
  private readonly PENDING_REGISTRATION_TTL_MS = 30000;

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
    this.pendingRegistrations = new Map();
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
        this.handleSipResponse(sipMsg, callId, rinfo);
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
      this.trackPendingRegistration(callId, sipMsg, rinfo);
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

    const clientTopVia = sipMsg.getTopVia();
    const clientBranch = clientTopVia ? sipMsg.getBranchFromVia(clientTopVia) : undefined;
    const clientRport = clientTopVia ? sipMsg.hasRPort(clientTopVia) : false;

    const branch = this.addProxyHeaders(sipMsg, 'UDP', this.config.PROXY_IP, this.config.SIP_UDP_PORT);

    if (callId) {
      this.storeClient(callId, rinfo.address, rinfo.port, {
        branch: clientBranch,
        proxyBranch: branch,
        rport: clientRport,
        sipMessage: sipMsg,
        upstreamKey: this.buildUpstreamKey(record),
      });
    }

    this.logger.info(`Forwarding SIP request to PBX ${record.ip} (branch ${branch})`);
    this.udpSocket.send(Buffer.from(sipMsg.toString()), record.udpPort, record.ip);
  }

  private handleSipResponse(
    sipMsg: SipMessage,
    callId: string | undefined,
    rinfo: dgram.RemoteInfo
  ): void {
    if (!callId) {
      this.logger.warn(`No Call-ID found in SIP response.`);
      return;
    }

    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      this.logger.warn(`No client info found for Call-ID ${callId}`);
      return;
    }

    if (clientInfo.upstreamKey) {
      const receivedUpstream = this.buildUpstreamKeyFromRinfo(rinfo);
      if (receivedUpstream !== clientInfo.upstreamKey) {
        this.logger.warn(
          `Dropping SIP response for Call-ID ${callId} from unexpected upstream ${receivedUpstream}`
        );
        return;
      }
    }

    const topVia = sipMsg.getTopVia();
    const viaBranch = topVia ? sipMsg.getBranchFromVia(topVia) : undefined;
    if (clientInfo.proxyBranch && clientInfo.proxyBranch !== viaBranch) {
      this.logger.warn(
        `Dropping SIP response for Call-ID ${callId} due to Via branch mismatch (expected ${clientInfo.proxyBranch}, got ${viaBranch})`
      );
      return;
    }

    this.handleRegistrationResponse(callId, sipMsg, rinfo);
    this.prepareSipResponseForClient(sipMsg, clientInfo, 'UDP', this.config.PROXY_IP);

    this.logger.info(`Forwarding SIP response to client at ${clientInfo.address}:${clientInfo.port}`);
    this.udpSocket.send(Buffer.from(sipMsg.toString()), clientInfo.port, clientInfo.address);
  }

  private trackPendingRegistration(callId: string | undefined, sipMsg: SipMessage, rinfo: dgram.RemoteInfo): void {
    if (!callId) return;

    const aor = sipMsg.getAddressOfRecord();
    const domain = aor?.host ?? sipMsg.getTargetHost();
    const user = aor?.user ?? sipMsg.getTargetUser();

    if (!domain || !user) {
      this.logger.warn('Unable to extract AoR from REGISTER request');
      return;
    }

    const existing = this.pendingRegistrations.get(callId);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => this.pendingRegistrations.delete(callId), this.PENDING_REGISTRATION_TTL_MS);

    this.pendingRegistrations.set(callId, {
      domain,
      user,
      clientAddress: rinfo.address,
      clientPort: rinfo.port,
      contact: sipMsg.getContactHeaders()[0],
      timeout,
    });
  }

  private handleRegistrationResponse(
    callId: string,
    sipMsg: SipMessage,
    _rinfo: dgram.RemoteInfo
  ): void {
    const pending = this.pendingRegistrations.get(callId);
    if (!pending) return;

    const clearPending = () => {
      clearTimeout(pending.timeout);
      this.pendingRegistrations.delete(callId);
    };

    const status = sipMsg.getStatusCode();
    const cseqMethod = sipMsg.getCSeqMethod()?.toUpperCase();
    if (cseqMethod !== 'REGISTER') {
      clearPending();
      return;
    }

    if (!status || status < 200 || status >= 300) {
      clearPending();
      return;
    }

    const expires = this.getRegistrationExpiry(sipMsg);
    if (expires === null) {
      clearPending();
      return;
    }

    if (expires === 0) {
      const removed = this.registrationStore.remove(pending.domain, pending.user);
      if (removed) {
        this.logger.info(`Removed registration for ${pending.user}@${pending.domain}`);
      }
      clearPending();
      return;
    }

    const contact = sipMsg.getContactHeaders()[0] ?? pending.contact;
    const binding = {
      domain: pending.domain,
      user: pending.user,
      clientAddress: pending.clientAddress,
      clientPort: pending.clientPort,
      contact,
      expiresAt: Date.now() + expires * 1000,
    };

    this.registrationStore.upsert(binding);
    clearPending();

    this.logger.info(
      `Stored registration for ${binding.user}@${binding.domain} via ${binding.clientAddress}:${binding.clientPort} (expires in ${expires}s)`
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

    const record = this.records.getRecord(domain);
    if (record?.udpPort && (rinfo.address !== record.ip || rinfo.port !== record.udpPort)) {
      this.logger.warn(
        `Dropping PBX-sourced request from unexpected endpoint ${rinfo.address}:${rinfo.port} (expected ${record.ip}:${record.udpPort})`
      );
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
      this.storeClient(sipMsg.getCallId()!, rinfo.address, rinfo.port, {
        proxyBranch: branch,
        sipMessage: sipMsg,
        upstreamKey: this.buildClientUpstreamKey(binding),
      });
    }

    this.logger.info(
      `Forwarding PBX request for ${targetUser}@${domain} to ${binding.clientAddress}:${binding.clientPort}`
    );
    this.udpSocket.send(Buffer.from(sipMsg.toString()), binding.clientPort, binding.clientAddress);
  }

  private buildUpstreamKey(record: IPValue): string {
    return `udp:${record.ip}:${record.udpPort}`;
  }

  private buildUpstreamKeyFromRinfo(rinfo: dgram.RemoteInfo): string {
    return `udp:${rinfo.address}:${rinfo.port}`;
  }

  private buildClientUpstreamKey(binding: { clientAddress: string; clientPort: number }): string {
    return `udp:${binding.clientAddress}:${binding.clientPort}`;
  }
}
