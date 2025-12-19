// BaseProxy.ts
import type tls from 'tls';
import { IPValue, IRecordStore, RegistrationStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';
import { SipMessage } from './../sip';
import { ProtocalType } from '../constants/protocal';

export interface ClientInfo {
  address: string;
  port: number;
  branch?: string;
  proxyBranch?: string;
  rport?: boolean;
  timeout?: NodeJS.Timeout;
  socket?: tls.TLSSocket;
  upstreamKey?: string;
}

export abstract class BaseProxy implements Proxy {
  protected records: IRecordStore;
  protected logger: Logger;
  protected clientMap: Map<string, ClientInfo>;
  protected registrationStore: RegistrationStore;
  private mediaPassthrough: boolean;
  private CLIENT_TIMEOUT_MS = 30000; // 30 seconds timeout

  constructor(
    records: IRecordStore,
    logger: Logger,
    registrationStore: RegistrationStore,
    options: { mediaPassthrough?: boolean } = {}
  ) {
    this.records = records;
    this.logger = logger;
    this.clientMap = new Map();
    this.registrationStore = registrationStore;
    this.mediaPassthrough = options.mediaPassthrough ?? false;
  }

  protected getTargetRecord(destinationHost: string): IPValue | null {
    const target = this.records.getRecord(destinationHost);
    if (!target) {
      this.logger.warn(`No record found for hostname: ${destinationHost}`);
      return null;
    }
    return target;
  }

  protected storeClient(
    callId: string,
    address: string,
    port: number,
    options: {
      branch?: string;
      proxyBranch?: string;
      rport?: boolean;
      sipMessage?: SipMessage;
      transportSocket?: tls.TLSSocket;
      upstreamKey?: string;
    } = {}
  ): void {
    this.logger.info(`Storing client ${address}:${port} for Call-ID ${callId}`);
    const existingClient = this.clientMap.get(callId);

    let branch = options.branch ?? existingClient?.branch;
    let proxyBranch = options.proxyBranch ?? existingClient?.proxyBranch;
    let rport = options.rport ?? existingClient?.rport ?? false;

    if (options.sipMessage && options.branch === undefined) {
      const topVia = options.sipMessage.getTopVia();
      if (topVia) {
        branch = options.sipMessage.getBranchFromVia(topVia) ?? branch;
        rport = options.sipMessage.hasRPort(topVia);
      }
    }

    const client: ClientInfo = {
      address,
      port,
      branch,
      proxyBranch,
      rport,
      socket: options.transportSocket ?? existingClient?.socket,
      upstreamKey: options.upstreamKey ?? existingClient?.upstreamKey,
    };

    this.clientMap.set(callId, client);
    this.resetClientTimeout(callId, client);
  }

  protected getClient(callId: string): ClientInfo | undefined {
    const client = this.clientMap.get(callId);
    if (client) {
      this.resetClientTimeout(callId, client);
    }
    return client;
  }

  protected removeClient(callId: string): void {
    const client = this.clientMap.get(callId);
    if (client?.timeout) clearTimeout(client.timeout);
    this.clientMap.delete(callId);
    this.logger.info(`Removed client for Call-ID ${callId}`);
  }

  protected addProxyHeaders(
    sipMessage: SipMessage,
    transport: ProtocalType,
    proxyIp: string,
    proxyPort: number
  ): string {
    const branch = sipMessage.generateBranch();
    const viaHeader = this.buildProxyViaHeader(transport, proxyIp, proxyPort, branch);
    sipMessage.addViaTop(viaHeader);
    sipMessage.updateContact(proxyIp, proxyPort);
    if (!this.mediaPassthrough) {
      sipMessage.updateSdpIp(proxyIp);
    }
    return branch;
  }

  protected prepareSipResponseForClient(
    sipMessage: SipMessage,
    clientInfo: ClientInfo,
    transport: ProtocalType,
    proxyIp: string
  ): void {
    const viaHeader = this.buildClientViaHeader(transport, clientInfo);
    sipMessage.replaceViaTop(viaHeader);
    if (!this.mediaPassthrough) {
      sipMessage.updateSdpIp(proxyIp);
    }
  }

  private buildProxyViaHeader(
    transport: ProtocalType,
    host: string,
    port: number,
    branch: string
  ): string {
    return `SIP/2.0/${transport} ${host}:${port};branch=${branch}`;
  }

  private buildClientViaHeader(transport: ProtocalType, clientInfo: ClientInfo): string {
    const parts = [`SIP/2.0/${transport} ${clientInfo.address}:${clientInfo.port}`];
    if (clientInfo.branch) {
      parts.push(`;branch=${clientInfo.branch}`);
    }
    if (clientInfo.rport) {
      parts.push(`;rport`);
    }
    return parts.join('');
  }

  private resetClientTimeout(callId: string, client: ClientInfo): void {
    if (client.timeout) {
      clearTimeout(client.timeout);
    }
    client.timeout = setTimeout(() => {
      this.logger.warn(`Client ${client.address}:${client.port} for Call-ID ${callId} timed out and was removed`);
      this.clientMap.delete(callId);
    }, this.CLIENT_TIMEOUT_MS);
  }

  abstract start(): void;
}
