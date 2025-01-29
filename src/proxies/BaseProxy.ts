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

  protected getTargetIp(destinationHost: string): string | null {
    const target = this.records.getRecord(destinationHost);
    if (!target) {
      this.logger.warn(`No record found for hostname: ${destinationHost}`);
      return null;
    }
    return target.ip ? target.ip  : null;
  }

  protected storeClient(targetIp: string, targetPort: number, clientAddress: string, clientPort: number): void {
    const key = `${targetIp}:${targetPort}`;

    // Remove existing timeout if entry already exists
    if (this.clientMap.has(key)) {
      clearTimeout(this.clientMap.get(key)!.timeout);
    }

    // Set timeout for cleanup
    const timeout = setTimeout(() => {
      this.logger.warn(`Cleaning up stale entry for ${key}`);
      this.clientMap.delete(key);
    }, this.REQUEST_TIMEOUT_MS);

    // Store client information
    this.clientMap.set(key, { address: clientAddress, port: clientPort, timeout });

    this.logger.info(`Stored client ${clientAddress}:${clientPort} for ${targetIp}:${targetPort}`);
  }

  protected getClient(targetIp: string, targetPort: number) {
    return this.clientMap.get(`${targetIp}:${targetPort}`);
  }

  protected removeClient(targetIp: string, targetPort: number): void {
    const key = `${targetIp}:${targetPort}`;
    const client = this.clientMap.get(key);

    if (client) {
      clearTimeout(client.timeout);
      this.clientMap.delete(key);
      this.logger.info(`Removed client entry for ${key}`);
    }
  }

  abstract start(): void;
}
