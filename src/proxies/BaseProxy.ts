// BaseProxy.ts
import { IPValue, IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';
import { SipMessage } from './../sip';

export interface ClientInfo {
  address: string;
  port: number;
  branch?: string;
  rport?: boolean;
  timeout?: NodeJS.Timeout;
}

export abstract class BaseProxy implements Proxy {
  protected records: IRecordStore;
  protected logger: Logger;
  protected clientMap: Map<string, ClientInfo>;
  private CLIENT_TIMEOUT_MS = 30000; // 30 seconds timeout

  constructor(records: IRecordStore, logger: Logger) {
    this.records = records;
    this.logger = logger;
    this.clientMap = new Map();
  }

  protected getTargetRecord(destinationHost: string): IPValue | null {
    const target = this.records.getRecord(destinationHost);
    if (!target) {
      this.logger.warn(`No record found for hostname: ${destinationHost}`);
      return null;
    }
    return target;
  }

  protected storeClient(callId: string, address: string, port: number, sipMessage?: string): void {
    this.logger.info(`Storing client ${address}:${port} for Call-ID ${callId}`);
    const existingClient = this.clientMap.get(callId);
    if (existingClient?.timeout) clearTimeout(existingClient.timeout);

    let branch: string | undefined;
    let rport = false;

    if (sipMessage) {
      const msg = new SipMessage(sipMessage);
      const topVia = msg.getTopVia();
      if (topVia) {
        branch = msg.getBranchFromVia(topVia);
        rport = msg.hasRPort(topVia);
      }
    }

    const timeout = setTimeout(() => {
      this.logger.warn(`Client ${address}:${port} for Call-ID ${callId} timed out and was removed`);
      this.clientMap.delete(callId);
    }, this.CLIENT_TIMEOUT_MS);

    this.clientMap.set(callId, { address, port, branch, rport, timeout });
  }

  protected getClient(callId: string): ClientInfo | undefined {
    return this.clientMap.get(callId);
  }

  protected removeClient(callId: string): void {
    const client = this.clientMap.get(callId);
    if (client?.timeout) clearTimeout(client.timeout);
    this.clientMap.delete(callId);
    this.logger.info(`Removed client for Call-ID ${callId}`);
  }

  protected removeClientOn2xx(callId: string, sipMessage: string): void {
    const msg = new SipMessage(sipMessage);
    const status = msg.getStatusCode();
    if (status && status >= 200 && status < 300) {
      this.removeClient(callId);
    } else {
      this.logger.info(`Client for Call-ID ${callId} not removed (status code: ${status})`);
    }
  }

  abstract start(): void;
}