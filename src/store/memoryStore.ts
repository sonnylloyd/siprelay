import { IRecordStore, IPValue } from "./";

export class MemoryStore implements IRecordStore {
  private records: Record<string, IPValue> = {};
  private ipIndex: Map<string, string> = new Map();

  public addRecord(hostname: string, ip: IPValue): IPValue {
    const existing = this.records[hostname];
    if (existing) {
      this.ipIndex.delete(existing.ip);
    }
    this.records[hostname] = ip;
    this.ipIndex.set(ip.ip, hostname);
    return ip;
  }

  public getRecord(hostname: string): IPValue | undefined {
    return this.records[hostname];
  }

  public getAllRecords(): Record<string, IPValue> {
    return this.records;
  }

  public deleteRecord(hostname: string): boolean {
    const existing = this.records[hostname];
    if (existing) {
      delete this.records[hostname];
      this.ipIndex.delete(existing.ip);
      return true;
    }
    return false;
  }

  public updateRecord(hostname: string, ip: IPValue): IPValue | undefined {
    const existing = this.records[hostname];
    if (existing) {
      if (existing.ip !== ip.ip) {
        this.ipIndex.delete(existing.ip);
        this.ipIndex.set(ip.ip, hostname);
      }
      this.records[hostname] = ip;
      return ip;
    }
    return undefined;
  }

  public findHostnameByIp(ip: string): string | undefined {
    return this.ipIndex.get(ip);
  }
}
