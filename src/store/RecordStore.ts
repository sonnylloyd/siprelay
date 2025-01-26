export type IPValue = string | null;

export interface IRecord {
    ipv4: IPValue;
    ipv6: IPValue;
}

export interface IRecordStore {
    addRecord(hostname: string, ipv4: IPValue, ipv6: IPValue): IRecord;
    getRecord(hostname: string): IRecord | undefined;
    getAllRecords(): Record<string, IRecord>;
    deleteRecord(hostname: string): boolean;
    updateRecord(hostname: string, ipv4: IPValue, ipv6: IPValue): IRecord | undefined;
}