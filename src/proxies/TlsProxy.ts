// TlsProxy.ts
import fs from 'fs';
import tls from 'tls';
import { once } from 'events';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { IPValue, IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { SipMessage } from '../sip';

export class TlsProxy extends BaseProxy {
  private config: Config;
  private server: tls.Server;
  private tlsOptions: tls.TlsOptions;
  private upstreamConnections: Map<string, { socket: tls.TLSSocket; idleTimer?: NodeJS.Timeout }>;
  private connectionPromises: Map<string, Promise<tls.TLSSocket>>;
  private readonly UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(records: IRecordStore, config: Config, logger: Logger) {
    super(records, logger);
    this.config = config;
    this.tlsOptions = this.loadCredentials();
    this.server = this.createServer();
    this.upstreamConnections = new Map();
    this.connectionPromises = new Map();
  }

  private createServer(): tls.Server {
    return tls.createServer(this.tlsOptions, this.handleIncomingConnection.bind(this));
  }

  private handleIncomingConnection(socket: tls.TLSSocket): void {
    socket.on('data', this.handleSocketData.bind(this, socket));
    socket.on('error', this.handleSocketError.bind(this, socket));
  }

  private handleSocketData(socket: tls.TLSSocket, data: Buffer): void {
    const sipMessageStr = data.toString();
    const sipMessage = new SipMessage(sipMessageStr);
    const callId = sipMessage.getCallId();

    if (sipMessage.isResponse()) {
      this.handleResponseTLS(socket, sipMessage, callId);
      return;
    }

    this.handleRequestTLSWithLogging(socket, sipMessage, callId);
  }

  private handleSocketError(_socket: tls.TLSSocket, err: Error): void {
    this.logger.error('TLS socket error:', err);
  }

  private handleRequestTLSWithLogging(socket: tls.TLSSocket, sipMessage: SipMessage, callId: string | undefined): void {
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

  private async handleRequestTLS(socket: tls.TLSSocket, sipMessage: SipMessage, callId: string | undefined): Promise<void> {
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

    if (callId) {
      const remoteAddress = socket.remoteAddress || 'unknown';
      const remotePort = socket.remotePort || 5061;
      this.storeClient(callId, remoteAddress, remotePort, sipMessage);
    }

    const branch = this.addProxyHeaders(sipMessage, 'TLS', this.config.PROXY_IP, this.config.SIP_TLS_PORT);
    this.logger.info(`New proxy Via Header with branch ${branch}`);

    try {
      const upstream = await this.ensureUpstreamConnection(record);
      const payload = sipMessage.toString();
      if (!upstream.write(payload)) {
        await once(upstream, 'drain');
      }
      this.resetIdleTimer(this.getUpstreamKey(record), upstream);
    } catch (error) {
      this.logger.error(`Error forwarding SIP TLS message to ${record.ip}:${record.tlsPort}`, error);
    }
  }

  private handleResponseTLS(socket: tls.TLSSocket, sipMessage: SipMessage, callId: string | undefined): void {
    if (!callId) {
      this.logger.warn('Call-ID missing in SIP response');
      return;
    }

    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      this.logger.warn(`No client info for Call-ID: ${callId}`);
      return;
    }

    this.removeClientOn2xx(callId, sipMessage);

    this.prepareSipResponseForClient(sipMessage, clientInfo, 'TLS', this.config.PROXY_IP);

    socket.write(sipMessage.toString());
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

      const client = tls.connect(
        {
          host: record.ip,
          port: record.tlsPort,
          rejectUnauthorized: false,
        },
        () => this.onUpstreamSecureConnect(key, client, resolve, onEarlyError, onEarlyClose)
      );

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

  private handleUpstreamIdleTimeout(key: string, socket: tls.TLSSocket): void {
    this.logger.info(`Closing idle upstream TLS connection ${key}`);
    socket.destroy();
    this.upstreamConnections.delete(key);
  }

  private handleServerListening(): void {
    this.logger.info(`TLS Proxy listening on port ${this.config.SIP_TLS_PORT} 🔐`);
  }
}
