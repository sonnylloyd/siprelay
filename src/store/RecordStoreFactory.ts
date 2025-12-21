import { Config } from '../configurations';
import { IRecordStore } from './RecordStore';
import { MemoryStore } from './memoryStore';

/**
 * Factory for creating the configured record store implementation.
 * Defaults to MemoryStore until additional store types are supported.
 */
export class RecordStoreFactory {
  public static create(config: Config): IRecordStore {
    // Placeholder for future selection based on config.
    // e.g. if (config.RECORD_STORE === 'redis') return new RedisStore(config);
    return new MemoryStore();
  }
}
