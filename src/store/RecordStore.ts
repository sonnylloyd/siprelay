// store/index.ts
export interface IPValue {
    ip: string;
    udpPort?: number;
    tlsPort?: number;
}
  
export interface IRecordStore {
    addRecord(hostname: string, ip: IPValue): IPValue;
    getRecord(hostname: string): IPValue | undefined;
    getAllRecords(): Record<string, IPValue>;
    deleteRecord(hostname: string): boolean;
    updateRecord(hostname: string, ip: IPValue): IPValue | undefined;
}