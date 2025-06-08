// TlsProxy.ts
import tls from 'tls';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { IPValue, IRecordStore } from './../store';
import { Logger } from '../logging/Logger';

export class TlsProxy extends BaseProxy {
  private config: Config;
  private server: tls.Server;

  constructor(records: IRecordStore, config: Config, logger: Logger) {
    super(records, logger);
    this.config = config;
    this.server = this.createServer();
  }

  private createServer(): tls.Server {
    return tls.createServer(
      {
        key: this.config.SIP_TLS_KEY_PATH,
        cert: this.config.SIP_TLS_CERT_PATH,
        requestCert: false,
      },
      (socket) => {
        socket.on('data', (data) => {
          const sipMessage = data.toString();
          const callId = this.extractCallId(sipMessage);
          const isResponse = this.isResponse(sipMessage);

          if (isResponse) {
            this.handleResponseTLS(socket, sipMessage, callId);
          } else {
            this.handleRequestTLS(socket, sipMessage, callId);
          }
        });

        socket.on('error', (err) => {
          this.logger.error('TLS socket error:', err);
        });
      }
    );
  }

  private handleRequestTLS(socket: tls.TLSSocket, sipMessage: string, callId: string | null): void {
    const destinationHost = this.extractSipHost(sipMessage);
    if (!destinationHost) {
      this.logger.warn('Failed to extract destination from SIP message');
      return;
    }

    const record:IPValue|null = this.getTargetRecord(destinationHost);
    if (!record || !record.tlsPort) {
      this.logger.warn(`No TLS route found for host: ${destinationHost}`);
      return;
    }

    if (callId) {
      const remoteAddress = socket.remoteAddress || 'unknown';
      const remotePort = socket.remotePort || 5061;
      this.storeClient(callId, remoteAddress, remotePort);
    }

    let modifiedMessage = this.addViaHeader(sipMessage, this.config.PROXY_IP, this.config.SIP_TLS_PORT, 'TLS');
    modifiedMessage = this.rewriteContactHeader(modifiedMessage, this.config.PROXY_IP, this.config.SIP_TLS_PORT);
    modifiedMessage = this.rewriteSdpBody(modifiedMessage, this.config.PROXY_IP);

    const client = tls.connect(
      {
        host: record.ip,
        port: record.tlsPort,
        rejectUnauthorized: false,
      },
      () => client.write(modifiedMessage)
    );
    
    client.on('error', (err) => {
      this.logger.error(`Error forwarding SIP TLS message to ${record.ip}:`, err);
    });
  }

  private handleResponseTLS(socket: tls.TLSSocket, sipMessage: string, callId: string | null): void {
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

    let modifiedMessage = this.removeViaHeader(sipMessage, callId, 'TLS');
    modifiedMessage = this.rewriteSdpBody(modifiedMessage, this.config.PROXY_IP);

    socket.write(modifiedMessage);
  }

  public start(): void {
    this.server.listen(this.config.SIP_TLS_PORT, '::', () => {
      this.logger.info(`TLS Proxy listening on port ${this.config.SIP_TLS_PORT} 🔐`);
    });
  }
}