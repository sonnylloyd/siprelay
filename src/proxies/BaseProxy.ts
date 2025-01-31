import { IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';

export interface ClientInfo {
  address: string;
  port: number;
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

  protected extractSipHost(message: string): string | null {
    const match = message.match(/^(?:INVITE|REGISTER|ACK|BYE|CANCEL|OPTIONS|INFO|MESSAGE|SUBSCRIBE|NOTIFY)\s+sip:([^>\s;]+)/i);
    return match ? match[1] : null;
  }

  protected getTargetIp(destinationHost: string): string | null {
    const target = this.records.getRecord(destinationHost);
    if (!target) {
      this.logger.warn(`No record found for hostname: ${destinationHost}`);
      return null;
    }
    return target.ip || null;
  }

  protected extractCallId(sipMessage: string): string | null {
    const match = sipMessage.match(/Call-ID: (.+)/i);
    return match ? match[1].trim() : null;
  }

  protected storeClient(callId: string, address: string, port: number): void {
    this.logger.info(`Storing client ${address}:${port} for Call-ID ${callId}`);
    
    // Clear previous timeout if entry exists
    const existingClient = this.clientMap.get(callId);
    if (existingClient?.timeout) {
      clearTimeout(existingClient.timeout);
    }

    // Set auto-remove timeout
    const timeout = setTimeout(() => {
      this.logger.warn(`Client ${address}:${port} for Call-ID ${callId} timed out and was removed`);
      this.clientMap.delete(callId);
    }, this.CLIENT_TIMEOUT_MS);

    this.clientMap.set(callId, { address, port, timeout });
  }

  protected getClient(callId: string): ClientInfo | undefined {
    return this.clientMap.get(callId);
  }

  protected removeClient(callId: string): void {
    const client = this.clientMap.get(callId);
    if (client?.timeout) {
      clearTimeout(client.timeout);
    }
    this.clientMap.delete(callId);
    this.logger.info(`Removed client for Call-ID ${callId}`);
  }

  protected isResponse(sipMessage: string): boolean {
    return /^SIP\/2.0\s+\d{3}/.test(sipMessage);
  }

  protected addViaHeader(sipMessage: string, proxyIp: string, proxyPort: number): string {
    const viaHeader = `Via: SIP/2.0/UDP ${proxyIp}:${proxyPort};branch=z9hG4bKproxy\r\n`;
    return sipMessage.replace(/(To: .+?\r\n)/i, `$1${viaHeader}`);
  }

  protected removeViaHeader(sipMessage: string, callId: string): string {
    const clientInfo = this.getClient(callId);
    if (!clientInfo) {
      this.logger.warn(`No client info found for Call-ID ${callId}. Sending response as-is.`);
      return sipMessage.replace(/^Via: .*?\r\n/i, ''); // Fallback: just remove Via if no mapping
    }
  
    // Replace the proxy's Via header with the original client
    return sipMessage.replace(
      /^Via: .*?\r\n/i,
      `Via: SIP/2.0/UDP ${clientInfo.address}:${clientInfo.port};branch=z9hG4bKclient\r\n`
    );
  }
  abstract start(): void;
}