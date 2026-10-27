import { checkProxyRequest } from '../sip/ProxyRequestPolicy';
import { PushCoordinator } from '../push/PushCoordinator';
import { RegistrationService } from '../sip/RegistrationService';
import { RegistrationBinding } from '../store';
import fs from 'fs';
import tls from 'tls';
import net, { Socket } from 'net';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { IPValue, IRecordStore, RegistrationStore } from './../store';
import { Logger } from '../logging/Logger';
import { SipMessage, SipFrameDecoder, SipFrameDecoderError, SipResponseValidator } from '../sip';

type ConnectionListener = (socket: Socket) => void;
type ServerFactory = (options: tls.TlsOptions, listener: ConnectionListener) => net.Server;

export type StreamProxyOverrides = {
  transport?: 'TCP' | 'TLS';
  tlsOptions?: tls.TlsOptions;
  pushCoordinator?: PushCoordinator;
  serverFactory?: ServerFactory;
  tlsConnect?: (options: tls.ConnectionOptions) => Socket;
};

export class StreamProxy extends BaseProxy {
  private readonly incomingSockets = new Set<Socket>();
  private readonly registrationService: RegistrationService;
  private readonly pushCoordinator?: PushCoordinator;
  private readonly config: Config;
  private readonly transport: 'TCP' | 'TLS';
  private readonly server: net.Server;
  private readonly tlsOptions: tls.TlsOptions;
  private readonly upstreamCa?: Buffer;
  private readonly serverFactory: ServerFactory;
  private readonly tlsConnectFn: (options: tls.ConnectionOptions) => Socket;
  private readonly upstreamConnections: Map<string, { socket: Socket; idleTimer?: NodeJS.Timeout }>;
  private readonly connectionPromises: Map<string, Promise<Socket>>;
  private readonly UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  private readonly frameDecoders: WeakMap<Socket, SipFrameDecoder>;
  private readonly responseValidator: SipResponseValidator;

  constructor(
    records: IRecordStore,
    config: Config,
    logger: Logger,
    registrationStore: RegistrationStore,
    overrides: StreamProxyOverrides = {}
  ) {
    super(records, logger, registrationStore);
    this.config = config;
    this.transport = overrides.transport ?? 'TLS';
    this.upstreamCa = this.transport === 'TLS' && config.SIP_TLS_CA_PATH ? fs.readFileSync(config.SIP_TLS_CA_PATH) : undefined;
    this.registrationService = new RegistrationService(registrationStore, logger, 30_000, config.SIP_REGISTRATION_MODE);
    this.pushCoordinator = overrides.pushCoordinator;
    this.tlsConnectFn = overrides.tlsConnect ?? (this.transport === 'TLS' ? tls.connect : options => net.connect({ host: options.host, port: options.port! }));
    this.tlsOptions = this.transport === 'TLS' ? { ...overrides.tlsOptions ?? this.loadCredentials(), minVersion: 'TLSv1.2', handshakeTimeout: 10_000 } : {};
    this.serverFactory =
      overrides.serverFactory ?? ((opts, listener) => this.transport === 'TLS' ? tls.createServer(opts, listener) : net.createServer(listener));
    this.server = this.createServer();
    this.server.maxConnections = 2_000;
    this.upstreamConnections = new Map();
    this.connectionPromises = new Map();
    this.frameDecoders = new WeakMap();
    this.responseValidator = new SipResponseValidator(logger);
  }

  private createServer(): net.Server {
    return this.serverFactory(this.tlsOptions, this.handleIncomingConnection.bind(this));
  }

  private handleIncomingConnection(socket: Socket): void {
    if (this.incomingSockets.size >= 2_000) { socket.destroy(); return; }
    this.incomingSockets.add(socket);
    socket.setTimeout?.(60_000, () => socket.destroy());
    this.frameDecoders.set(socket, new SipFrameDecoder());
    socket.on('data', (chunk) => this.handleSocketData(socket, chunk));
    socket.on('error', (err) => this.handleSocketError(socket, err));
    socket.on('close', () => {
      this.incomingSockets.delete(socket);
      this.frameDecoders.delete(socket);
      this.cleanupSocketClients(socket);
    });
  }

  private handleSocketData(socket: Socket, data: Buffer): void {
    if (!this.ingress.allow(socket.remoteAddress ?? 'unknown')) { socket.destroy(); return; }
    const messages = this.decodeSipFrames(socket, data);
    for (const sipMessageStr of messages) {
      if (!this.ingress.allow(socket.remoteAddress ?? 'unknown')) { socket.destroy(); return; }
      const sipMessage = new SipMessage(sipMessageStr);
      if (!sipMessage.isValid()) { socket.destroy(); return; }
      const callId = sipMessage.getCallId();

      if (sipMessage.isResponse()) {
        this.handleClientResponse(socket, sipMessage, callId);
        continue;
      }

      const peerIp = socket.remoteAddress?.replace(/^::ffff:/, '');
      const peers = Object.entries(this.records.getAllRecords()).filter(([, record]) => record.ip === peerIp && this.getPort(record));
      const targetDomain = sipMessage.getAddressOfRecord()?.host;
      const pbx = peers.find(([domain]) => domain === targetDomain)?.[1] ?? (peers.length === 1 ? peers[0][1] : undefined);
      if (pbx) this.forwardPbxRequest(this.getUpstreamKey(pbx), socket, sipMessage);
      else if (peers.length > 0) socket.destroy();
      else this.handleRequestTLSWithLogging(socket, sipMessage, callId);
    }
  }

  private handleSocketError(_socket: Socket, err: Error): void {
    this.logger.error('TLS socket error:', err);
  }

  private handleRequestTLSWithLogging(
    socket: Socket,
    sipMessage: SipMessage,
    callId: string | undefined
  ): void {
    void this.handleRequestTLS(socket, sipMessage, callId).catch((err) => {
      this.logger.error('Failed to process inbound TLS SIP request', err);
    });
  }

  private loadCredentials(): tls.TlsOptions {
    try {
      const key = fs.readFileSync(this.config.SIP_TLS_KEY_PATH);
      const cert = fs.readFileSync(this.config.SIP_TLS_CERT_PATH);
      return {
        key,
        cert,
        requestCert: false,
      };
    } catch (error) {
      this.logger.error('Failed to load TLS credentials', error);
      throw error;
    }
  }

  private async handleRequestTLS(
    socket: Socket,
    sipMessage: SipMessage,
    callId: string | undefined
  ): Promise<void> {
    sipMessage.setReceived(socket.remoteAddress ?? 'unknown', socket.remotePort ?? 5061);
    if (this.transactions.receiveRequest(sipMessage, this.tlsFlow(socket), true, packet => this.writeToSocket(socket, packet))) return;
    if (this.rejectUnsupportedRequest(socket, sipMessage)) return;
    if (!sipMessage.hasSafeRegistration(this.config.SIP_REGISTRATION_MODE)) { this.sendResponse(socket, sipMessage, 400, 'Bad Request'); return; }
    if (!sipMessage.decrementMaxForwards()) {
      if (sipMessage.getMethod() !== 'ACK') this.sendResponse(socket, sipMessage, 483, 'Too Many Hops');
      return;
    }
    if (sipMessage.hasUnsafeRouting(this.config.PROXY_IP)) return;
    const routeFlowToken = sipMessage.getRouteFlowToken();
    const destinationHost = sipMessage.takeProxyRoute(this.config.PROXY_IP) ?? sipMessage.getTargetHost()!;
    const record: IPValue | null = this.getTargetRecord(destinationHost);
    if (!record || !this.getPort(record)) {
      this.logger.warn(`No TLS route found for host: ${destinationHost}`);
      return;
    }

    const flow = this.tlsFlow(socket);
    const routeIdentity = routeFlowToken ? this.registrationStore.readFlowToken(routeFlowToken) : undefined;
    if (routeFlowToken && (routeIdentity?.flow !== flow || routeIdentity?.domain !== destinationHost.toLowerCase())) {
      if (sipMessage.getMethod() !== 'ACK') this.sendResponse(socket, sipMessage, 403, 'Forbidden'); return;
    }
    if (!this.dialogs.authorize(sipMessage, destinationHost, flow)) {
      if (sipMessage.getMethod() !== 'ACK') this.sendResponse(socket, sipMessage, 481, 'Call/Transaction Does Not Exist');
      return;
    }
    if (!this.dialogs.trackInvite(sipMessage, destinationHost, flow)) return;
    const dialog = this.dialogs.context(sipMessage, destinationHost, flow);
    const upstreamKey = this.getUpstreamKey(record);
    const branch = this.createProxyBranch(sipMessage, destinationHost, flow);
    if (sipMessage.getMethod() === 'REGISTER') {
      const token = this.config.SIP_REGISTRATION_MODE === 'path' && sipMessage.getContactHeaders().some(contact => contact.trim() !== '*') ? this.registrationStore.createFlowToken({ domain: destinationHost, user: sipMessage.getAddressOfRecord()!.user!, flow }) : undefined;
      if (token) sipMessage.addRegistrationPath(token, destinationHost, this.config.PROXY_IP, this.getListenPort(), this.transport);
      this.registrationService.trackRequest(sipMessage, {
        address: socket.remoteAddress ?? 'unknown', port: socket.remotePort ?? 5061, transport: this.transport, socket, flowToken: token,
      }, branch);
    }
    const serverKey = this.transactions.serverKey(sipMessage, flow);
    const original = sipMessage.clone();
    this.addProxyHeaders(sipMessage, this.transport, this.config.PROXY_IP, this.getListenPort(), destinationHost, branch, this.config.SIP_REGISTRATION_MODE, this.registrationStore.getFlowToken(destinationHost, flow));
    if (sipMessage.getMethod() !== 'ACK' && callId && !this.storeClient(sipMessage.getTransactionKey(), socket.remoteAddress ?? 'unknown', socket.remotePort ?? 5061, {
      proxyBranch: branch, transportSocket: socket, upstreamKey, dialog, managed: true,
    })) return;

    try {
      const upstream = await this.ensureUpstreamConnection(record);
      const transaction = this.getClient(sipMessage.getTransactionKey());
      if (transaction) transaction.responseSocket = upstream;
      if (socket.destroyed) return;
      if (!this.transactions.forward(sipMessage, serverKey, this.tlsFlow(upstream), true, packet => this.writeToSocket(upstream, packet))) this.removeClient(sipMessage.getTransactionKey());
      this.resetIdleTimer(upstreamKey, upstream);
    } catch (error) {
      this.logger.error(`Error forwarding SIP TLS message to ${record.ip}:${record.tlsPort}`, error);
      this.removeClient(sipMessage.getTransactionKey());
      if (sipMessage.getMethod() !== 'ACK' && !socket.destroyed) this.sendResponse(socket, original, 503, 'Service Unavailable');
    }
  }

  private handleClientResponse(
    socket: Socket,
    sipMessage: SipMessage,
    callId: string | undefined
  ): void {
    const clientInfo = this.getClient(sipMessage.getTransactionKey(), false);
    if (!clientInfo?.socket || clientInfo.socket.destroyed || clientInfo.responseSocket !== socket) {
      this.transactions.receiveResponse(sipMessage, this.tlsFlow(socket));
      return;
    }
    const validation = this.responseValidator.validate({
      callId, expectedFromTag: clientInfo.dialog?.fromTag, expectedToTag: clientInfo.dialog?.toTag, expectedProxyBranch: clientInfo.proxyBranch,
      expectedSocket: clientInfo.responseSocket, actualSocket: socket, sipMessage,
    });
    if (!validation.ok) return;
    this.transactions.receiveResponse(sipMessage, this.tlsFlow(socket), () => {
      this.dialogs.observeResponse(sipMessage, clientInfo.dialog);
      this.registrationService.handleResponse(sipMessage);
    });
  }

  public start(): void {
    this.server.listen(this.getListenPort(), '::', this.handleServerListening.bind(this));
  }

  private getUpstreamKey(record: IPValue): string {
    const endpoint = `${record.ip}:${this.getPort(record)}`;
    return this.transport === 'TLS' && record.tlsServerName ? `${endpoint}|${record.tlsServerName}` : endpoint;
  }

  private getPort(record: IPValue): number | undefined { return this.transport === 'TLS' ? record.tlsPort : record.tcpPort; }
  private getListenPort(): number { return this.transport === 'TLS' ? this.config.SIP_TLS_PORT : this.config.SIP_TCP_PORT; }

  private async ensureUpstreamConnection(record: IPValue): Promise<Socket> {
    const key = this.getUpstreamKey(record);
    const existing = this.upstreamConnections.get(key);
    if (existing && !existing.socket.destroyed) {
      this.resetIdleTimer(key, existing.socket);
      return existing.socket;
    }

    const pending = this.connectionPromises.get(key);
    if (pending) {
      const socket = await pending;
      this.resetIdleTimer(key, socket);
      return socket;
    }

    const connectPromise = new Promise<Socket>((resolve, reject) => {
      const onEarlyError = this.handleUpstreamEarlyError.bind(this, key, reject);
      const onEarlyClose = this.handleUpstreamEarlyClose.bind(this, key, reject);

      const client = this.tlsConnectFn({
        host: record.ip,
        port: this.getPort(record),
        ...(this.transport === 'TLS' && record.tlsServerName ? { servername: record.tlsServerName } : {}),
        ...(this.upstreamCa ? { ca: this.upstreamCa } : {}),
        rejectUnauthorized: this.config.SIP_TLS_REJECT_UNAUTHORIZED,
        minVersion: 'TLSv1.2',
      });

      const handleSecureConnect = () =>
        this.onUpstreamSecureConnect(key, client, resolve, onEarlyError, onEarlyClose);

      const handshakeTimer = setTimeout(() => { client.destroy(new Error('Upstream TLS handshake timed out')); }, 10_000);
      handshakeTimer.unref();
      const connectEvent = this.transport === 'TLS' ? 'secureConnect' : 'connect';
      client.once(connectEvent, () => clearTimeout(handshakeTimer));
      client.once('error', () => clearTimeout(handshakeTimer));
      client.once('close', () => clearTimeout(handshakeTimer));
      client.once(connectEvent, handleSecureConnect);
      client.once('error', onEarlyError);
      client.once('close', onEarlyClose);

      client.on('error', this.handleUpstreamError.bind(this, key, client));
      client.on('close', this.handleUpstreamClose.bind(this, key, client));
    });

    this.connectionPromises.set(key, connectPromise);

    try {
      const socket = await connectPromise;
      return socket;
    } finally {
      this.connectionPromises.delete(key);
    }
  }

  private registerUpstreamConnection(key: string, socket: Socket): void {
    const existing = this.upstreamConnections.get(key);
    if (existing?.idleTimer) clearTimeout(existing.idleTimer);
    this.frameDecoders.set(socket, new SipFrameDecoder());
    socket.on('data', (chunk) => this.handleUpstreamSocketData(key, socket, chunk));
    const idleTimer = this.createIdleTimer(key, socket);
    this.upstreamConnections.set(key, { socket, idleTimer });
  }

  private createIdleTimer(key: string, socket: Socket): NodeJS.Timeout {
    return setTimeout(
      this.handleUpstreamIdleTimeout.bind(this, key, socket),
      this.UPSTREAM_IDLE_TIMEOUT_MS
    );
  }

  private resetIdleTimer(key: string, socket: Socket): void {
    const entry = this.upstreamConnections.get(key);
    if (entry?.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = this.createIdleTimer(key, socket);
    } else {
      this.registerUpstreamConnection(key, socket);
    }
  }

  private handleUpstreamEarlyError(_key: string, reject: (error: Error) => void, err: Error): void {
    reject(err);
  }

  private handleUpstreamEarlyClose(key: string, reject: (error: Error) => void, _hadError?: boolean): void {
    reject(new Error(`TLS connection closed before secure handshake for ${key}`));
  }

  private onUpstreamSecureConnect(
    key: string,
    client: Socket,
    resolve: (socket: Socket) => void,
    onEarlyError: (err: Error) => void,
    onEarlyClose: (hadError?: boolean) => void
  ): void {
    client.setKeepAlive(true);
    client.off('error', onEarlyError);
    client.off('close', onEarlyClose);
    this.logger.info(`Established upstream TLS connection to ${key}`);
    this.registerUpstreamConnection(key, client);
    resolve(client);
  }

  private handleUpstreamError(key: string, client: Socket, err: Error): void {
    this.logger.error(`Upstream TLS error for ${key}`, err);
    client.destroy();
  }

  private handleUpstreamClose(key: string, socket: Socket, _hadError?: boolean): void {
    const entry = this.upstreamConnections.get(key);
    if (entry?.socket !== socket) return;
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
    if (entry?.socket) {
      this.frameDecoders.delete(entry.socket);
    }
    this.upstreamConnections.delete(key);
    this.logger.info(`Upstream TLS connection closed for ${key}`);
  }

  private handleUpstreamSocketData(key: string, socket: Socket, data: Buffer): void {
    if (this.upstreamConnections.get(key)?.socket !== socket) return;
    this.resetIdleTimer(key, socket);
    const messages = this.decodeSipFrames(socket, data);
    for (const sipRaw of messages) {
      this.forwardUpstreamSipMessage(key, sipRaw);
    }
  }

  private forwardUpstreamSipMessage(upstreamKey: string, rawMessage: string | Buffer): void {
    const sipMessage = new SipMessage(rawMessage);
    if (!sipMessage.isValid()) return;
    const socket = this.upstreamConnections.get(upstreamKey)?.socket;
    if (!socket) return;
    if (sipMessage.isResponse()) {
      this.handleClientResponse(socket, sipMessage, sipMessage.getCallId());
      return;
    }
    this.forwardPbxRequest(upstreamKey, socket, sipMessage);
  }

  private forwardPbxRequest(upstreamKey: string, socket: Socket, message: SipMessage): void {
    message.setReceived(socket.remoteAddress ?? 'unknown', socket.remotePort ?? 5061);
    if (this.transactions.receiveRequest(message, this.tlsFlow(socket), true, packet => this.writeToSocket(socket, packet))) return;
    if (this.rejectUnsupportedRequest(socket, message)) return;
    if (message.hasUnsafeRouting(this.config.PROXY_IP, true)) return;
    const routeFlowToken = message.getRouteFlowToken();
    const routeDomain = message.takeProxyRoute(this.config.PROXY_IP);
    if (!routeDomain && message.getTargetHost() !== this.config.PROXY_IP.toLowerCase()) {
      this.logger.warn('Dropping PBX TLS request outside the relay contact domain');
      return;
    }
    const user = message.getTargetUser();
    const route = this.transport === 'TLS' ? this.routeResolver.resolveTls(message, upstreamKey, routeDomain)
      : this.routeResolver.resolveTcp(message, upstreamKey, routeDomain);
    if (!route || !user) return;
    const { domain } = route;
    if (!message.decrementMaxForwards()) {
      if (message.getMethod() !== 'ACK') this.sendResponse(socket, message, 483, 'Too Many Hops');
      return;
    }
    if (routeFlowToken && this.registrationStore.readFlowToken(routeFlowToken)?.domain !== domain) {
      this.sendResponse(socket, message, 403, 'Forbidden'); return;
    }
    const binding = routeFlowToken ? this.registrationStore.getByFlowToken(routeFlowToken) : this.registrationStore.get(domain, user);
    if (routeFlowToken && !binding) { this.sendResponse(socket, message, 430, 'Flow Failed'); return; }
    if (!binding || binding.transport !== this.transport) return;
    const source = `${this.transport.toLowerCase()}:${upstreamKey}`;
    const original = message.clone();
    const handled = this.pushCoordinator?.handleRequest(message, source, binding, {
      deliver: fresh => this.deliverPbxRequest(socket, original.clone(), fresh),
      respond: (status, reason) => this.sendResponse(socket, message, status, reason),
    });
    if (handled) return;
    this.deliverPbxRequest(socket, message, binding);
  }

  private deliverPbxRequest(source: Socket, message: SipMessage, binding: RegistrationBinding): void {
    const destination = binding.socket;
    if (source.destroyed) return;
    if (!destination || destination.destroyed) {
      if (message.getMethod() !== 'ACK') this.sendResponse(source, message, 480, 'Temporarily Unavailable');
      return;
    }
    const dialog = this.dialogs.context(message, binding.domain, this.tlsFlow(destination));
    if (!binding.flowToken) message.useClientContact(binding.clientContact);
    const branch = this.createProxyBranch(message, binding.domain, this.tlsFlow(source));
    const serverKey = this.transactions.serverKey(message, this.tlsFlow(source));
    this.addProxyHeaders(message, this.transport, this.config.PROXY_IP, this.getListenPort(), binding.domain, branch, this.config.SIP_REGISTRATION_MODE, binding.flowToken);
    if (message.getMethod() !== 'ACK' && !this.storeClient(message.getTransactionKey(), source.remoteAddress ?? 'pbx', source.remotePort ?? 5061, {
      proxyBranch: branch, transportSocket: source, responseSocket: destination, dialog, managed: true,
    })) return;
    if (!this.transactions.forward(message, serverKey, this.tlsFlow(destination), true, packet => this.writeToSocket(destination, packet))) this.removeClient(message.getTransactionKey());
  }

  private handleUpstreamIdleTimeout(key: string, socket: Socket): void {
    this.logger.info(`Closing idle upstream TLS connection ${key}`);
    socket.destroy();
    this.frameDecoders.delete(socket);
    this.upstreamConnections.delete(key);
  }

  private cleanupSocketClients(socket: Socket): void {
    for (const [transactionKey, info] of this.clientMap.entries()) {
      if (info.socket === socket || info.responseSocket === socket) {
        this.removeClient(transactionKey);
      }
    }
  }

  private decodeSipFrames(socket: Socket, chunk: Buffer): Buffer[] {
    try {
      const decoder = this.getDecoder(socket);
      return decoder.feedBuffers(chunk, () => {
        void this.writeToSocket(socket, '\r\n').catch(error => this.logger.error('Failed to send TLS keepalive pong', error));
      });
    } catch (error) {
      if (error instanceof SipFrameDecoderError) {
        this.logger.warn(`Closing TLS socket: ${error.message}`);
      } else {
        this.logger.error('Unexpected SIP frame decode error', error);
      }
      socket.destroy();
      this.frameDecoders.delete(socket);
      return [];
    }
  }

  private getDecoder(socket: Socket): SipFrameDecoder {
    let decoder = this.frameDecoders.get(socket);
    if (!decoder) {
      decoder = new SipFrameDecoder();
      this.frameDecoders.set(socket, decoder);
    }
    return decoder;
  }

  private rejectUnsupportedRequest(socket: Socket, message: SipMessage): boolean {
    const rejection = checkProxyRequest(message, this.transport, this.config.SIP_REGISTRATION_MODE);
    if (!rejection) return false;
    if (message.getMethod() !== 'ACK') {
      const response = new SipMessage(message.createResponse(rejection.status, rejection.reason, rejection.headers));
      this.transactions.reply(message, this.tlsFlow(socket), response);
    }
    return true;
  }

  private sendResponse(socket: Socket, message: SipMessage, status: number, reason: string): void {
    const response = new SipMessage(message.createResponse(status, reason));
    // Deferred push/provider callbacks must not send a final response after the
    // owning transaction has expired or already completed.
    this.transactions.reply(message, this.tlsFlow(socket), response);
  }

  private async writeToSocket(socket: Socket, payload: string | Buffer): Promise<void> {
    if (socket.destroyed) throw new Error('TLS socket is closed');
    if (socket.write(payload)) return;

    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        socket.off('drain', onDrain);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onDrain = () => finish();
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error('TLS socket closed before its write drained'));
      socket.once('drain', onDrain);
      socket.once('error', onError);
      socket.once('close', onClose);
      // A transport may close synchronously inside write(), before listeners are attached.
      if (socket.destroyed) onClose();
    });
  }

  private handleServerListening(): void {
    this.logger.info(`${this.transport} Proxy listening on port ${this.getListenPort()}`);
  }
}
