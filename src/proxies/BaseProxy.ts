import { IRecordStore } from './../store';
import { Logger } from '../logging/Logger';
import { Proxy } from './Proxy';

export abstract class BaseProxy implements Proxy {
  protected records: IRecordStore;
  protected logger: Logger;

  constructor(records: IRecordStore, logger: Logger) {
    this.records = records;
    this.logger = logger;
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

  abstract start(): void;
}
