export type IPValue = string | null | undefined;

export interface IRecord {
    ip: IPValue;
}

export interface IRecordStore {
    addRecord(hostname: string, ip: IPValue): IRecord;
    getRecord(hostname: string): IRecord | undefined;
    getAllRecords(): Record<string, IRecord>;
    deleteRecord(hostname: string): boolean;
    updateRecord(hostname: string, ip: IPValue): IRecord | undefined;
}