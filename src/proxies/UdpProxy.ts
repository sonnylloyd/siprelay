// UdpProxy.ts
import dgram from 'dgram';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { Logger } from '../logging/Logger';
import { IPValue, IRecordStore, RegistrationStore } from './../store';
import { SipMessage, RegistrationService, SipResponseValidator } from '../sip';

export class UdpProxy extends BaseProxy {
  private config: Config;
  private udpSocket: dgram.Socket;
  private registrationService: RegistrationService;
  private responseValidator: SipResponseValidator;

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
    this.registrationService = new RegistrationService(registrationStore, logger);
    this.responseValidator = new SipResponseValidator(logger);
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
      this.registrationService.trackRequest(callId, sipMsg, rinfo);
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

    const validation = this.responseValidator.validate({
      callId,
      expectedUpstreamKey: clientInfo.upstreamKey,
      actualUpstreamKey: this.buildUpstreamKeyFromRinfo(rinfo),
      expectedProxyBranch: clientInfo.proxyBranch,
      sipMessage: sipMsg,
    });

    if (!validation.ok) {
      this.logger.warn(`Dropping SIP response for Call-ID ${callId}: ${validation.reason}`);
      return;
    }

    this.registrationService.handleResponse(callId, sipMsg);
    this.prepareSipResponseForClient(sipMsg, clientInfo, 'UDP', this.config.PROXY_IP);

    this.logger.info(`Forwarding SIP response to client at ${clientInfo.address}:${clientInfo.port}`);
    this.udpSocket.send(Buffer.from(sipMsg.toString()), clientInfo.port, clientInfo.address);
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
