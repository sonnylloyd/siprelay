import { checkProxyRequest } from '../sip/ProxyRequestPolicy';
import { PushCoordinator } from '../push/PushCoordinator';
import { RegistrationBinding } from '../store';
import dgram from 'dgram';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { Logger } from '../logging/Logger';
import { IPValue, IRecordStore, RegistrationStore } from './../store';
import { SipMessage, RegistrationService, SipResponseValidator } from '../sip';

interface UdpTransport {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'message', listener: (message: Buffer, peer: dgram.RemoteInfo) => void): void;
  bind(port: number, onListening: () => void): void;
  send(message: Buffer, port: number, address: string): void;
}

interface UdpProxyOptions {
  socket?: UdpTransport;
  pushCoordinator?: PushCoordinator;
}

export class UdpProxy extends BaseProxy {
  private readonly config: Config;
  private readonly udpSocket: UdpTransport;
  private readonly pushCoordinator?: PushCoordinator;
  private readonly registrationService: RegistrationService;
  private readonly responseValidator: SipResponseValidator;

  constructor(
    records: IRecordStore,
    config: Config,
    logger: Logger,
    registrationStore: RegistrationStore,
    options: UdpProxyOptions = {}
  ) {
    super(records, logger, registrationStore);
    this.config = config;
    this.udpSocket = options.socket ?? dgram.createSocket('udp4');
    this.pushCoordinator = options.pushCoordinator;
    this.registrationService = new RegistrationService(registrationStore, logger, 30_000, config.SIP_REGISTRATION_MODE);
    this.responseValidator = new SipResponseValidator(logger);
  }

  public start(): void {
    this.udpSocket.on('error', (err) => {
      this.logger.error('SIP UDP socket error', err);
    });

    this.udpSocket.on('message', (message, rinfo) => {
      if (message.length > 64 * 1024 || !this.ingress.allow(rinfo.address)) return;
      const sipMsg = new SipMessage(message, { datagram: true });
      if (!sipMsg.isValid()) return;
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
    sipMsg.setReceived(rinfo.address, rinfo.port);
    const flow = this.buildUpstreamKeyFromRinfo(rinfo);
    const responsePort = sipMsg.getUdpResponsePort(rinfo.port);
    if (this.transactions.receiveRequest(sipMsg, flow, false, packet => this.udpSocket.send(packet, responsePort, rinfo.address))) return;
    const rejection = checkProxyRequest(sipMsg, 'UDP', this.config.SIP_REGISTRATION_MODE);
    if (rejection) {
      if (sipMsg.getMethod() !== 'ACK') this.transactions.reply(sipMsg, flow, new SipMessage(sipMsg.createResponse(rejection.status, rejection.reason, rejection.headers)));
      return;
    }
    if (!sipMsg.hasSafeRegistration(this.config.SIP_REGISTRATION_MODE)) { this.sendResponse(sipMsg, rinfo, 400, 'Bad Request'); return; }
    if (!sipMsg.decrementMaxForwards()) {
      if (sipMsg.getMethod() !== 'ACK') {
        this.sendResponse(sipMsg, rinfo, 483, 'Too Many Hops');
      }
      return;
    }
    const method = sipMsg.getMethod();
    if (sipMsg.hasUnsafeRouting(this.config.PROXY_IP, this.records.findHostnameByIp(rinfo.address) !== undefined)) return;

    const routeFlowToken = sipMsg.getRouteFlowToken();
    const routeDomain = sipMsg.takeProxyRoute(this.config.PROXY_IP);
    const route = routeDomain ? this.records.getRecord(routeDomain) : undefined;
    const fromPbx = route?.ip === rinfo.address && route?.udpPort === rinfo.port;
    const destinationHost = routeDomain ?? sipMsg.getTargetHost()!;
    if (fromPbx || (!routeDomain && this.isRequestTargetingProxy(destinationHost))) {
      this.forwardRequestToRegisteredClient(sipMsg, rinfo, routeDomain, routeFlowToken);
      return;
    }

    const record: IPValue | null = this.getTargetRecord(destinationHost);
    if (!record || !record.udpPort) {
      this.logger.warn(`No UDP route found for SIP host: ${destinationHost}`);
      return;
    }

    const routeIdentity = routeFlowToken ? this.registrationStore.readFlowToken(routeFlowToken) : undefined;
    if (routeFlowToken && (routeIdentity?.flow !== flow || routeIdentity?.domain !== destinationHost.toLowerCase())) {
      if (method !== 'ACK') this.sendResponse(sipMsg, rinfo, 403, 'Forbidden'); return;
    }
    if (!this.dialogs.authorize(sipMsg, destinationHost, flow)) {
      if (method !== 'ACK') this.sendResponse(sipMsg, rinfo, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    if (!this.dialogs.trackInvite(sipMsg, destinationHost, flow)) return;
    const dialog = this.dialogs.context(sipMsg, destinationHost, flow);
    const branch = this.createProxyBranch(sipMsg, destinationHost, flow);
    if (method === 'REGISTER') {
      const token = this.config.SIP_REGISTRATION_MODE === 'path' && sipMsg.getContactHeaders().some(contact => contact.trim() !== '*') ? this.registrationStore.createFlowToken({ domain: destinationHost, user: sipMsg.getAddressOfRecord()!.user!, flow }) : undefined;
      if (token) sipMsg.addRegistrationPath(token, destinationHost, this.config.PROXY_IP, this.config.SIP_UDP_PORT, 'UDP');
      this.registrationService.trackRequest(sipMsg, { ...rinfo, flowToken: token }, branch);
    }
    const serverKey = this.transactions.serverKey(sipMsg, flow);
    this.addProxyHeaders(sipMsg, 'UDP', this.config.PROXY_IP, this.config.SIP_UDP_PORT, destinationHost, branch, this.config.SIP_REGISTRATION_MODE, this.registrationStore.getFlowToken(destinationHost, flow));
    if (method !== 'ACK' && callId && !this.storeClient(sipMsg.getTransactionKey(), rinfo.address, responsePort, {
      proxyBranch: branch, upstreamKey: this.buildUpstreamKey(record), dialog, managed: true,
    })) return;

    this.logger.debug(`Forwarding SIP request to PBX ${record.ip} (branch ${branch})`);
    if (!this.transactions.forward(sipMsg, serverKey, this.buildUpstreamKey(record), false, packet => this.udpSocket.send(packet, record.udpPort!, record.ip))) this.removeClient(sipMsg.getTransactionKey());
  }

  private handleSipResponse(
    sipMsg: SipMessage,
    callId: string | undefined,
    rinfo: dgram.RemoteInfo
  ): void {
    const clientInfo = this.getClient(sipMsg.getTransactionKey(), false);
    if (!clientInfo) {
      this.transactions.receiveResponse(sipMsg, this.buildUpstreamKeyFromRinfo(rinfo));
      return;
    }

    const validation = this.responseValidator.validate({
      callId,
      expectedFromTag: clientInfo.dialog?.fromTag,
      expectedToTag: clientInfo.dialog?.toTag,
      expectedUpstreamKey: clientInfo.upstreamKey,
      actualUpstreamKey: this.buildUpstreamKeyFromRinfo(rinfo),
      expectedProxyBranch: clientInfo.proxyBranch,
      sipMessage: sipMsg,
    });

    if (!validation.ok) {
      this.logger.warn(`Dropping SIP response for Call-ID ${callId}: ${validation.reason}`);
      return;
    }

    this.transactions.receiveResponse(sipMsg, this.buildUpstreamKeyFromRinfo(rinfo), () => {
      this.dialogs.observeResponse(sipMsg, clientInfo.dialog);
      this.registrationService.handleResponse(sipMsg);
    });
  }

  private isRequestTargetingProxy(targetHost: string | null): boolean {
    if (!targetHost) return false;
    return targetHost === this.config.PROXY_IP.toLowerCase();
  }

  private forwardRequestToRegisteredClient(sipMsg: SipMessage, rinfo: dgram.RemoteInfo, routeDomain?: string, routeFlowToken?: string): void {
    const targetUser = sipMsg.getTargetUser();
    if (!targetUser) {
      this.logger.warn('Failed to determine target user for PBX request');
      return;
    }

    const route = this.routeResolver.resolveUdp(sipMsg, rinfo, routeDomain);
    if (!route) {
      this.logger.warn(`Dropping PBX request from unrecognized endpoint ${rinfo.address}:${rinfo.port}`);
      return;
    }
    const { domain } = route;

    this.registrationStore.purgeExpired();
    if (routeFlowToken && this.registrationStore.readFlowToken(routeFlowToken)?.domain !== domain) {
      this.sendResponse(sipMsg, rinfo, 403, 'Forbidden'); return;
    }
    const binding = routeFlowToken ? this.registrationStore.getByFlowToken(routeFlowToken) : this.registrationStore.get(domain, targetUser);
    if (!binding) {
      if (routeFlowToken) this.sendResponse(sipMsg, rinfo, 430, 'Flow Failed');
      else this.logger.warn(`No registration binding for ${targetUser}@${domain}`);
      return;
    }

    if (binding.transport && binding.transport !== 'UDP') {
      this.logger.warn('Cross-transport PBX delivery is not supported');
      return;
    }
    const source = `udp:${rinfo.address}:${rinfo.port}`;
    const original = sipMsg.clone();
    const handled = this.pushCoordinator?.handleRequest(sipMsg, source, binding, {
      deliver: fresh => this.deliverToClient(original.clone(), rinfo, fresh),
      respond: (status, reason) => this.sendResponse(sipMsg, rinfo, status, reason),
    });
    if (handled) return;
    this.deliverToClient(sipMsg, rinfo, binding);
  }

  private deliverToClient(sipMsg: SipMessage, rinfo: dgram.RemoteInfo, binding: RegistrationBinding): void {
    if (binding.transport && binding.transport !== 'UDP') return;
    if (binding.dormant) { this.sendResponse(sipMsg, rinfo, 480, 'Temporarily Unavailable'); return; }
    const dialog = this.dialogs.context(sipMsg, binding.domain, this.buildClientUpstreamKey(binding));
    if (!binding.flowToken) sipMsg.useClientContact(binding.clientContact);
    const source = this.buildUpstreamKeyFromRinfo(rinfo);
    const branch = this.createProxyBranch(sipMsg, binding.domain, source);
    const responsePort = sipMsg.getUdpResponsePort(rinfo.port);
    const serverKey = this.transactions.serverKey(sipMsg, source);
    this.addProxyHeaders(sipMsg, 'UDP', this.config.PROXY_IP, this.config.SIP_UDP_PORT, binding.domain, branch, this.config.SIP_REGISTRATION_MODE, binding.flowToken);
    if (sipMsg.getMethod() !== 'ACK' && sipMsg.getCallId() && !this.storeClient(sipMsg.getTransactionKey(), rinfo.address, responsePort, {
      proxyBranch: branch, upstreamKey: this.buildClientUpstreamKey(binding), dialog, managed: true,
    })) return;
    if (!this.transactions.forward(sipMsg, serverKey, this.buildClientUpstreamKey(binding), false, packet => this.udpSocket.send(packet, binding.clientPort, binding.clientAddress))) this.removeClient(sipMsg.getTransactionKey());
  }

  private sendResponse(message: SipMessage, peer: { address: string; port: number }, status: number, reason: string): void {
    const response = new SipMessage(message.createResponse(status, reason));
    this.transactions.reply(message, this.buildUpstreamKeyFromRinfo(peer as dgram.RemoteInfo), response);
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
