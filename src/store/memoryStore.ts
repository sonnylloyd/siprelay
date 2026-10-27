import { IRecordStore, IPValue } from "./";

export class MemoryStore implements IRecordStore {
  private records: Record<string, IPValue> = Object.create(null);
  private ipIndex: Map<string, string> = new Map();

  public addRecord(hostname: string, ip: IPValue): IPValue {
    hostname = hostname.toLowerCase();
    const existing = this.records[hostname];
    if (existing) {
      this.removeIpMapping(existing.ip, hostname);
    }
    this.records[hostname] = ip;
    this.ipIndex.set(ip.ip, hostname);
    return ip;
  }

  public getRecord(hostname: string): IPValue | undefined {
    hostname = hostname.toLowerCase();
    return this.records[hostname];
  }

  public getAllRecords(): Record<string, IPValue> {
    return this.records;
  }

  public deleteRecord(hostname: string): boolean {
    hostname = hostname.toLowerCase();
    const existing = this.records[hostname];
    if (existing) {
      delete this.records[hostname];
      this.removeIpMapping(existing.ip, hostname);
      return true;
    }
    return false;
  }

  public updateRecord(hostname: string, ip: IPValue): IPValue | undefined {
    hostname = hostname.toLowerCase();
    const existing = this.records[hostname];
    if (existing) {
      if (existing.ip !== ip.ip) {
        this.removeIpMapping(existing.ip, hostname);
        this.ipIndex.set(ip.ip, hostname);
      }
      this.records[hostname] = ip;
      return ip;
    }
    return undefined;
  }

  private removeIpMapping(ip: string, hostname: string): void {
    if (this.ipIndex.get(ip) !== hostname) return;
    const replacement = Object.entries(this.records).reverse()
      .find(([otherHost, record]) => otherHost !== hostname && record.ip === ip);
    if (replacement) this.ipIndex.set(ip, replacement[0]);
    else this.ipIndex.delete(ip);
  }

  public findHostnameByIp(ip: string): string | undefined {
    return this.ipIndex.get(ip);
  }
}
