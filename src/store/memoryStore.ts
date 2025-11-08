import { IRecordStore, IPValue } from "./";

export class MemoryStore implements IRecordStore {
  private records: Record<string, IPValue> = {};

  public addRecord(hostname: string, ip: IPValue): IPValue {
    this.records[hostname] = ip;
    return ip;
  }

  public getRecord(hostname: string): IPValue | undefined {
    return this.records[hostname];
  }

  public getAllRecords(): Record<string, IPValue> {
    return this.records;
  }

  public deleteRecord(hostname: string): boolean {
    if (this.records[hostname]) {
      delete this.records[hostname];
      return true;
    }
    return false;
  }

  public updateRecord(hostname: string, ip: IPValue): IPValue | undefined {
    if (this.records[hostname]) {
      this.records[hostname] = ip;
      return ip;
    }
    return undefined;
  }

  public findHostnameByIp(ip: string): string | undefined {
    for (const [hostname, value] of Object.entries(this.records)) {
      if (value.ip === ip) {
        return hostname;
      }
    }
    return undefined;
  }
}
