export interface ServiceWatcher {
    watch(): Promise<void>;
    update(): Promise<void>;
}