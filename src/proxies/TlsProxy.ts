// TlsProxy.ts
import fs from 'fs';
import tls from 'tls';
import { once } from 'events';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { IPValue, IRecordStore, RegistrationStore } from './../store';
import { Logger } from '../logging/Logger';
import { SipMessage } from '../sip';

type ConnectionListener = (socket: tls.TLSSocket) => void;
type ServerFactory = (options: tls.TlsOptions, listener: ConnectionListener) => tls.Server;

type TlsProxyOverrides = {
  tlsOptions?: tls.TlsOptions;
  serverFactory?: ServerFactory;
  tlsConnect?: typeof tls.connect;
};

export class TlsProxy extends BaseProxy {
  private config: Config;
  private server: tls.Server;
  private tlsOptions: tls.TlsOptions;
  private readonly serverFactory: ServerFactory;
  private readonly tlsConnectFn: typeof tls.connect;
  private upstreamConnections: Map<string, { socket: tls.TLSSocket; idleTimer?: NodeJS.Timeout }>;
  private connectionPromises: Map<string, Promise<tls.TLSSocket>>;
  private readonly UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  private socketBuffers: WeakMap<tls.TLSSocket, string>;

  constructor(
    records: IRecordStore,
    config: Config,
    logger: Logger,
    registrationStore: RegistrationStore,
    overrides: TlsProxyOverrides = {}
  ) {
    super(records, logger, registrationStore, {
      mediaPassthrough: config.MEDIA_MODE === 'passthrough',
    });
    this.config = config;
    this.tlsConnectFn = overrides.tlsConnect ?? tls.connect;
    this.tlsOptions = overrides.tlsOptions ?? this.loadCredentials();
    this.serverFactory =
      overrides.serverFactory ?? ((opts, listener) => tls.createServer(opts, listener));
    this.server = this.createServer();
    this.upstreamConnections = new Map();
    this.connectionPromises = new Map();
    this.socketBuffers = new WeakMap();
  }

  private createServer(): tls.Server {
    return this.serverFactory(this.tlsOptions, this.handleIncomingConnection.bind(this));
  }

  private handleIncomingConnection(socket: tls.TLSSocket): void {
    this.socketBuffers.set(socket, '');
    socket.on('data', (chunk) => this.handleSocketData(socket, chunk));
    socket.on('error', (err) => this.handleSocketError(socket, err));
    socket.on('close', () => this.cleanupSocketClients(socket));
  }

  private handleSocketData(socket: tls.TLSSocket, data: Buffer): void {
    const messages = this.extractSipFrames(socket, data);
    for (const sipMessageStr of messages) {
      const sipMessage = new SipMessage(sipMessageStr);
      const callId = sipMessage.getCallId();

      if (sipMessage.isResponse()) {
        this.handleClientResponse(sipMessage, callId);
        continue;
      }

      this.handleRequestTLSWithLogging(socket, sipMessage, callId);
    }
  }

  private handleSocketError(_socket: tls.TLSSocket, err: Error): void {
    this.logger.error('TLS socket error:', err);
  }

  private handleRequestTLSWithLogging(
    socket: tls.TLSSocket,
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
    socket: tls.TLSSocket,
    sipMessage: SipMessage,
    callId: string | undefined
  ): Promise<void> {
    const destinationHost = sipMessage.getTargetHost();
    if (!destinationHost) {
      this.logger.warn('Failed to extract destination from SIP message');
      return;
    }

    const record: IPValue | null = this.getTargetRecord(destinationHost);
    if (!record || !record.tlsPort) {
      this.logger.warn(`No TLS route found for host: ${destinationHost}`);
      return;
    }

    const upstreamKey = this.getUpstreamKey(record);

    if (callId) {
      const remoteAddress = socket.remoteAddress || 'unknown';
      const remotePort = socket.remotePort || 5061;
      this.storeClient(callId, remoteAddress, remotePort, {
        sipMessage,
        transportSocket: socket,
        upstreamKey,
      });
    }

    const branch = this.addProxyHeaders(
      sipMessage,
      'TLS',
      this.config.PROXY_IP,
      this.config.SIP_TLS_PORT
    );
    this.logger.info(`New proxy Via Header with branch ${branch}`);

    try {
      const upstream = await this.ensureUpstreamConnection(record);
      const payload = sipMessage.toString();
      await this.writeToSocket(upstream, payload);
      this.resetIdleTimer(upstreamKey, upstream);
    } catch (error) {
      this.logger.error(`Error forwarding SIP TLS message to ${record.ip}:${record.tlsPort}`, error);
    }
  }

  private handleClientResponse(sipMessage: SipMessage, callId: string | undefined): void {
    if (!callId) {
      this.logger.warn('Call-ID missing in SIP response');
      return;
    }

    const clientInfo = this.getClient(callId);
    if (!clientInfo?.upstreamKey) {
      this.logger.warn(`No upstream mapping for Call-ID ${callId}`);
      return;
    }

    const upstreamEntry = this.upstreamConnections.get(clientInfo.upstreamKey);
    if (!upstreamEntry || upstreamEntry.socket.destroyed) {
      this.logger.warn(`Upstream connection unavailable for Call-ID ${callId}`);
      return;
    }

    const payload = sipMessage.toString();
    void (async () => {
      try {
        await this.writeToSocket(upstreamEntry.socket, payload);
        this.resetIdleTimer(clientInfo.upstreamKey!, upstreamEntry.socket);
      } catch (error) {
        this.logger.error(`Failed to forward SIP response for Call-ID ${callId}`, error);
      }
    })();
  }

  public start(): void {
    this.server.listen(this.config.SIP_TLS_PORT, '::', this.handleServerListening.bind(this));
  }

  private getUpstreamKey(record: IPValue): string {
    return `${record.ip}:${record.tlsPort}`;
  }

  private async ensureUpstreamConnection(record: IPValue): Promise<tls.TLSSocket> {
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

    const connectPromise = new Promise<tls.TLSSocket>((resolve, reject) => {
      const onEarlyError = this.handleUpstreamEarlyError.bind(this, key, reject);
      const onEarlyClose = this.handleUpstreamEarlyClose.bind(this, key, reject);

      const client = this.tlsConnectFn({
        host: record.ip,
        port: record.tlsPort,
        rejectUnauthorized: this.config.SIP_TLS_REJECT_UNAUTHORIZED,
      });

      const handleSecureConnect = () =>
        this.onUpstreamSecureConnect(key, client, resolve, onEarlyError, onEarlyClose);

      client.once('secureConnect', handleSecureConnect);
      client.once('error', onEarlyError);
      client.once('close', onEarlyClose);

      client.on('error', this.handleUpstreamError.bind(this, key, client));
      client.on('close', this.handleUpstreamClose.bind(this, key));
    });

    this.connectionPromises.set(key, connectPromise);

    try {
      const socket = await connectPromise;
      return socket;
    } finally {
      this.connectionPromises.delete(key);
    }
  }

  private registerUpstreamConnection(key: string, socket: tls.TLSSocket): void {
    const existing = this.upstreamConnections.get(key);
    if (existing?.idleTimer) clearTimeout(existing.idleTimer);
    this.socketBuffers.set(socket, '');
    socket.on('data', (chunk) => this.handleUpstreamSocketData(key, socket, chunk));
    const idleTimer = this.createIdleTimer(key, socket);
    this.upstreamConnections.set(key, { socket, idleTimer });
  }

  private createIdleTimer(key: string, socket: tls.TLSSocket): NodeJS.Timeout {
    return setTimeout(
      this.handleUpstreamIdleTimeout.bind(this, key, socket),
      this.UPSTREAM_IDLE_TIMEOUT_MS
    );
  }

  private resetIdleTimer(key: string, socket: tls.TLSSocket): void {
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
    client: tls.TLSSocket,
    resolve: (socket: tls.TLSSocket) => void,
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

  private handleUpstreamError(key: string, client: tls.TLSSocket, err: Error): void {
    this.logger.error(`Upstream TLS error for ${key}`, err);
    client.destroy();
  }

  private handleUpstreamClose(key: string, _hadError?: boolean): void {
    const entry = this.upstreamConnections.get(key);
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
    this.upstreamConnections.delete(key);
    this.logger.info(`Upstream TLS connection closed for ${key}`);
  }

  private handleUpstreamSocketData(key: string, socket: tls.TLSSocket, data: Buffer): void {
    this.resetIdleTimer(key, socket);
    const messages = this.extractSipFrames(socket, data);
    for (const sipRaw of messages) {
      this.forwardUpstreamSipMessage(sipRaw);
    }
  }

  private forwardUpstreamSipMessage(rawMessage: string): void {
    const sipMessage = new SipMessage(rawMessage);
    if (!sipMessage.isResponse()) {
      this.logger.warn('Dropping unsupported upstream SIP request');
      return;
    }

    const callId = sipMessage.getCallId();
    if (!callId) {
      this.logger.warn('Received upstream SIP response without Call-ID');
      return;
    }

    const clientInfo = this.getClient(callId);
    if (!clientInfo?.socket || clientInfo.socket.destroyed) {
      this.logger.warn(`No active client socket for Call-ID ${callId}`);
      return;
    }

    this.prepareSipResponseForClient(sipMessage, clientInfo, 'TLS', this.config.PROXY_IP);
    const payload = sipMessage.toString();

    void (async () => {
      try {
        await this.writeToSocket(clientInfo.socket!, payload);
      } catch (error) {
        this.logger.error(`Failed to forward SIP response to client for Call-ID ${callId}`, error);
      }
    })();
  }

  private handleUpstreamIdleTimeout(key: string, socket: tls.TLSSocket): void {
    this.logger.info(`Closing idle upstream TLS connection ${key}`);
    socket.destroy();
    this.upstreamConnections.delete(key);
  }

  private cleanupSocketClients(socket: tls.TLSSocket): void {
    for (const [callId, info] of this.clientMap.entries()) {
      if (info.socket === socket) {
        this.removeClient(callId);
      }
    }
  }

  private extractSipFrames(socket: tls.TLSSocket, chunk: Buffer): string[] {
    const previous = this.socketBuffers.get(socket) ?? '';
    let buffer = previous + chunk.toString();
    const messages: string[] = [];

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headers = buffer.slice(0, headerEnd);
      const contentLength = this.parseContentLength(headers);
      const totalLength = headerEnd + 4 + contentLength;

      if (buffer.length < totalLength) break;

      messages.push(buffer.slice(0, totalLength));
      buffer = buffer.slice(totalLength);
    }

    this.socketBuffers.set(socket, buffer);
    return messages;
  }

  private parseContentLength(headers: string): number {
    const match = headers.match(/Content-Length:\s*(\d+)/i);
    if (!match) return 0;
    const len = Number.parseInt(match[1], 10);
    return Number.isFinite(len) ? len : 0;
  }

  private async writeToSocket(socket: tls.TLSSocket, payload: string): Promise<void> {
    if (!socket.write(payload)) {
      await once(socket, 'drain');
    }
  }

  private handleServerListening(): void {
    this.logger.info(`TLS Proxy listening on port ${this.config.SIP_TLS_PORT} 🔐`);
  }
}
