import { Config } from '../configurations';
import { Logger } from '../logging/Logger';
import { IRecordStore } from '../store';
import { DockerWatcher } from './DockerWatcher';
import { ServiceWatcher } from './ServiceWatcher';

/**
 * Simple factory for creating a ServiceWatcher implementation.
 * Currently defaults to DockerWatcher but is ready for future expansion.
 */
export class ServiceWatcherFactory {
  public static create(config: Config, records: IRecordStore, logger: Logger): ServiceWatcher {
    // Placeholder for future strategy selection based on config.
    // e.g. if (config.WATCHER === 'kubernetes') return new KubeWatcher(...);
    return new DockerWatcher(records, logger);
  }
}
