import { IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';

export abstract class BaseProxy implements Proxy {
  protected records: IRecordStore;
  protected logger: Logger;
  protected clientMap: Map<string, { address: string; port: number; timeout?: NodeJS.Timeout }>;
  protected REQUEST_TIMEOUT_MS = 10000; // 10 seconds before cleanup

  constructor(records: IRecordStore, logger: Logger) {
    this.records = records;
    this.logger = logger;
    this.clientMap = new Map();
  }

  protected extractSipHost(message: string, protocol: 'UDP' | 'TLS'): string | null {
    const regex = new RegExp(`Via:\\s*SIP\\/2\\.0\\/${protocol}\\s+([\\w.-]+)`);
    const match = message.match(regex);
    return match ? match[1] : null;
  }

  /** Extracts Call-ID from a SIP message */
  protected extractCallId(message: string): string | null {
    const match = message.match(/Call-ID:\s*([\w\-\.@]+)/i);
    return match ? match[1] : null;
  }

  protected getTargetIp(destinationHost: string): string | null {
    const target = this.records.getRecord(destinationHost);
    if (!target) {
      this.logger.warn(`No record found for hostname: ${destinationHost}`);
      return null;
    }
    return target.ip ? target.ip  : null;
  }

  /** Stores a client (Call-ID → IP:Port) for response routing */
  protected storeClient(callId: string, clientAddress: string, clientPort: number): void {
    if (!callId) return;

    // Clear old timeout if entry already exists
    if (this.clientMap.has(callId)) {
      clearTimeout(this.clientMap.get(callId)!.timeout);
    }

    // Set timeout to clean up stale entries
    const timeout = setTimeout(() => {
      this.logger.warn(`Cleaning up stale Call-ID: ${callId}`);
      this.clientMap.delete(callId);
    }, this.REQUEST_TIMEOUT_MS);

    // Store client info
    this.clientMap.set(callId, { address: clientAddress, port: clientPort, timeout });

    this.logger.info(`Stored Call-ID: ${callId} → ${clientAddress}:${clientPort}`);
  }

  /** Retrieves stored client info by Call-ID */
  protected getClient(callId: string) {
    return this.clientMap.get(callId);
  }

  /** Removes a stored client after forwarding the response */
  protected removeClient(callId: string): void {
    if (this.clientMap.has(callId)) {
      clearTimeout(this.clientMap.get(callId)!.timeout);
      this.clientMap.delete(callId);
      this.logger.info(`Removed Call-ID: ${callId}`);
    }
  }

  abstract start(): void;
}
