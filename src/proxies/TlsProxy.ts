// TlsProxy.ts
import fs from 'fs';
import tls from 'tls';
import { Config } from '../configurations';
import { BaseProxy } from './BaseProxy';
import { IPValue, IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { SipMessage } from '../sip';

export class TlsProxy extends BaseProxy {
  private config: Config;
  private server: tls.Server;
  private tlsOptions: tls.TlsOptions;

  constructor(records: IRecordStore, config: Config, logger: Logger) {
    super(records, logger);
    this.config = config;
    this.tlsOptions = this.loadCredentials();
    this.server = this.createServer();
  }

  private createServer(): tls.Server {
    return tls.createServer(
      this.tlsOptions,
      (socket) => {
        socket.on('data', (data) => {
          const sipMessageStr = data.toString();
          const sipMessage = new SipMessage(sipMessageStr);
          const callId = sipMessage.getCallId();

          if (sipMessage.isResponse()) {
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

  private handleRequestTLS(socket: tls.TLSSocket, sipMessage: SipMessage, callId: string | undefined): void {
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

    const branch = sipMessage.generateBranch();
    sipMessage.addViaTop(`SIP/2.0/TLS ${this.config.PROXY_IP}:${this.config.SIP_TLS_PORT};branch=${branch}`);
    this.logger.info(`New proxy Via Header with branch ${branch}`);

    sipMessage.updateContact(this.config.PROXY_IP, this.config.SIP_TLS_PORT);
    sipMessage.updateSdpIp(this.config.PROXY_IP);

    const client = tls.connect(
      {
        host: record.ip,
        port: record.tlsPort,
        rejectUnauthorized: false,
      },
      () => client.write(sipMessage.toString())
    );

    client.on('error', (err) => {
      this.logger.error(`Error forwarding SIP TLS message to ${record.ip}:`, err);
    });
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

    const newVia = `SIP/2.0/TLS ${clientInfo.address}:${clientInfo.port}` +
      (clientInfo.branch ? `;branch=${clientInfo.branch}` : '') +
      (clientInfo.rport ? `;rport` : '');

    sipMessage.replaceViaTop(newVia);
    sipMessage.updateSdpIp(this.config.PROXY_IP);

    socket.write(sipMessage.toString());
  }

  public start(): void {
    this.server.listen(this.config.SIP_TLS_PORT, '::', () => {
      this.logger.info(`TLS Proxy listening on port ${this.config.SIP_TLS_PORT} 🔐`);
    });
  }
}
