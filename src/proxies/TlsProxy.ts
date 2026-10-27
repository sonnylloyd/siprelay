import { StreamProxy, StreamProxyOverrides } from './StreamProxy';
import { Config } from '../configurations';
import { Logger } from '../logging/Logger';
import { IRecordStore, RegistrationStore } from '../store';

/** TLS SIP transport; shared stream framing and routing live in StreamProxy. */
export class TlsProxy extends StreamProxy {
  constructor(records: IRecordStore, config: Config, logger: Logger, registrations: RegistrationStore, overrides: StreamProxyOverrides = {}) {
    super(records, config, logger, registrations, { ...overrides, transport: 'TLS' });
  }
}
