import { createContainer, asClass, asFunction, InjectionMode } from 'awilix';
import { Config } from './configurations';
import { RecordStoreFactory, RegistrationStore } from './store';
import { ServiceWatcherFactory } from './watchers';
import { ConsoleLogger } from './logging';
import { UdpProxy } from './proxies/UdpProxy';
import { TlsProxy } from './proxies/TlsProxy';
import { ApiServer } from './http';
import { ProxyInitializer } from './bootstrap/ProxyInitializer';

const container = createContainer({ injectionMode: InjectionMode.PROXY });

container.register({
  logger: asClass(ConsoleLogger).singleton(),
  config: asClass(Config).singleton(),
  records: asFunction(({ config }) => RecordStoreFactory.create(config)).singleton(),
  registrationStore: asClass(RegistrationStore).singleton(),
  serviceWatcher: asFunction(({ config, records, logger }) =>
    ServiceWatcherFactory.create(config, records, logger)
  ).singleton(),
  udpProxy: asFunction(
    ({ records, config, logger, registrationStore }) =>
      new UdpProxy(records, config, logger, registrationStore)
  ).singleton(),
  tlsProxy: asFunction(
    ({ records, config, logger, registrationStore }) =>
      new TlsProxy(records, config, logger, registrationStore)
  ).singleton(),
  apiServer: asFunction(({ config, logger, records }) => new ApiServer(config, logger, records)).singleton(),
  proxyInitializer: asFunction(
    ({ udpProxy, tlsProxy, config, logger }) => new ProxyInitializer(udpProxy, tlsProxy, config, logger)
  ).singleton(),
});

export { container };
