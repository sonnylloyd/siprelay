import { TransactionLayer } from '../sip/transactions/TransactionLayer';
import { IngressLimiter } from '../security/IngressLimiter';
import crypto from 'crypto';
import { DialogContext, DialogGuard } from '../security/DialogGuard';
import type { Socket } from 'net';
import { IPValue, IRecordStore, RegistrationStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';
import { SipMessage } from '../sip/SipMessage';
import { formatSipHost } from '../sip/SipUri';
import { SipTransport } from '../constants/transport';
import { PbxRouteResolver } from './PbxRouteResolver';

export interface ClientInfo {
  address: string;
  port: number;
  proxyBranch?: string;
  timeout?: NodeJS.Timeout;
  socket?: Socket;
  upstreamKey?: string;
  responseSocket?: Socket;
  dialog?: DialogContext;
  managed?: boolean;
}

export abstract class BaseProxy implements Proxy {
  protected readonly transactions: TransactionLayer;
  protected readonly ingress = new IngressLimiter();
  protected readonly dialogs = new DialogGuard();
  private readonly branchSecret = crypto.randomBytes(32);
  private readonly socketFlows = new WeakMap<Socket, string>();
  protected readonly routeResolver: PbxRouteResolver;
  protected readonly records: IRecordStore;
  protected readonly logger: Logger;
  protected readonly clientMap: Map<string, ClientInfo>;
  protected readonly registrationStore: RegistrationStore;
  private readonly clientTimeoutMs = 180_000; // Allow ringing and delayed final responses.

  constructor(
    records: IRecordStore,
    logger: Logger,
    registrationStore: RegistrationStore
  ) {
    this.records = records;
    this.routeResolver = new PbxRouteResolver(records);
    this.logger = logger;
    this.clientMap = new Map();
    this.transactions = new TransactionLayer({
      onError: error => this.logger.error('SIP transaction transport error', error),
      onClientTerminated: key => this.removeClient(key),
    });
    this.registrationStore = registrationStore;
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
    transactionKey: string,
    address: string,
    port: number,
    options: {
      proxyBranch?: string;
      transportSocket?: Socket;
      upstreamKey?: string;
      responseSocket?: Socket;
      dialog?: DialogContext;
      managed?: boolean;
    } = {}
  ): boolean {
    if (!this.clientMap.has(transactionKey) && this.clientMap.size >= 10_000) return false;
    this.logger.debug(`Storing client ${address}:${port} for transaction ${transactionKey}`);
    const existingClient = this.clientMap.get(transactionKey);
    if (existingClient?.timeout) clearTimeout(existingClient.timeout);

    const client: ClientInfo = {
      address,
      port,
      proxyBranch: options.proxyBranch ?? existingClient?.proxyBranch,
      socket: options.transportSocket ?? existingClient?.socket,
      upstreamKey: options.upstreamKey ?? existingClient?.upstreamKey,
      responseSocket: options.responseSocket ?? existingClient?.responseSocket,
      dialog: options.dialog ?? existingClient?.dialog,
      managed: options.managed ?? existingClient?.managed,
    };

    this.clientMap.set(transactionKey, client);
    this.resetClientTimeout(transactionKey, client);
    return true;
  }

  protected getClient(transactionKey: string, touch = true): ClientInfo | undefined {
    const client = this.clientMap.get(transactionKey);
    if (client && touch) {
      this.resetClientTimeout(transactionKey, client);
    }
    return client;
  }

  protected removeClient(transactionKey: string): void {
    const client = this.clientMap.get(transactionKey);
    if (client?.timeout) clearTimeout(client.timeout);
    this.clientMap.delete(transactionKey);
    this.logger.debug(`Removed client for transaction ${transactionKey}`);
  }

  protected addProxyHeaders(
    sipMessage: SipMessage,
    transport: SipTransport,
    proxyIp: string,
    proxyPort: number,
    domain?: string,
    suppliedBranch?: string,
    registrationMode: 'path' | 'contact' = 'contact',
    flowToken?: string
  ): string {
    const branch = suppliedBranch ?? this.createProxyBranch(sipMessage, domain ?? '', 'internal');
    const viaHeader = this.buildProxyViaHeader(transport, proxyIp, proxyPort, branch);
    sipMessage.addViaTop(viaHeader);
    if (sipMessage.getMethod() === 'REGISTER' && registrationMode === 'contact') sipMessage.updateContact(proxyIp, proxyPort);
    if (domain) sipMessage.addRecordRoute(domain, proxyIp, proxyPort, transport, flowToken);
    return branch;
  }

  protected prepareSipResponseForClient(
    sipMessage: SipMessage
  ): void {
    sipMessage.removeViaTop();
  }

  protected tlsFlow(socket: Socket): string {
    let flow = this.socketFlows.get(socket);
    if (!flow) { flow = `tls:${crypto.randomUUID()}`; this.socketFlows.set(socket, flow); }
    return flow;
  }

  protected createProxyBranch(message: SipMessage, domain: string, flow: string): string {
    const identity = [domain.toLowerCase(), flow, message.getCallId(), message.getCSeqNumber(), message.getTopVia()];
    return `z9hG4bK${crypto.createHmac('sha256', this.branchSecret).update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
  }

  private buildProxyViaHeader(
    transport: SipTransport,
    host: string,
    port: number,
    branch: string
  ): string {
    const address = formatSipHost(host);
    return `SIP/2.0/${transport} ${address}:${port};branch=${branch}`;
  }

  private resetClientTimeout(transactionKey: string, client: ClientInfo): void {
    if (client.managed) return;
    if (client.timeout) {
      clearTimeout(client.timeout);
    }
    client.timeout = setTimeout(() => {
      this.logger.warn(`Client ${client.address}:${client.port} for transaction ${transactionKey} timed out and was removed`);
      this.clientMap.delete(transactionKey);
    }, this.clientTimeoutMs);
    client.timeout.unref();
  }

  public disposeTransactions(): void { this.transactions.dispose(); }

  abstract start(): void;
}
