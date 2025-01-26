import { IRecordStore, IRecord } from "./";

export class MemoryStore implements IRecordStore {
    private records: Record<string, IRecord> = {};
  
    public addRecord(hostname: string, ipv4: string, ipv6: string): IRecord {
      return this.records[hostname] = { ipv4, ipv6 };
    }
  
    public getRecord(hostname: string): IRecord | undefined {
      return this.records[hostname];
    }
  
    public getAllRecords(): Record<string, IRecord> {
      return this.records;
    }

    public deleteRecord(hostname: string): boolean {
      if (this.records[hostname]) {
        delete this.records[hostname];
        return true;
      }
      return false;
    }

    public updateRecord(hostname: string, ipv4: string, ipv6: string): IRecord | undefined {
      if (this.records[hostname]) {
        const updatedRecord: IRecord = { ipv4, ipv6 };
        this.records[hostname] = updatedRecord;
        return updatedRecord;
      }
      return undefined;
    }
}