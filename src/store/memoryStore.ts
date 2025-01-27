import { IRecordStore, IRecord } from "./";

export class MemoryStore implements IRecordStore {
    private records: Record<string, IRecord> = {};
  
    public addRecord(hostname: string, ip: string): IRecord {
      return this.records[hostname] = { ip };
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

    public updateRecord(hostname: string, ip: string): IRecord | undefined {
      if (this.records[hostname]) {
        const updatedRecord: IRecord = { ip };
        this.records[hostname] = updatedRecord;
        return updatedRecord;
      }
      return undefined;
    }
}