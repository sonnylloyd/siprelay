import { TcpProxy } from './proxies/TcpProxy';
import { createContainer, asClass, asFunction, InjectionMode } from 'awilix';
import { Config } from './configurations';
import { IRecordStore, MemoryStore, RegistrationStore } from './store';
import { DockerWatcher, ServiceWatcher } from './watchers';
import { ConsoleLogger, Logger } from './logging';
import { UdpProxy } from './proxies/UdpProxy';
import { TlsProxy } from './proxies/TlsProxy';
import { ApiServer } from './http';
import { ProxyInitializer } from './bootstrap/ProxyInitializer';
import { PushService } from './push/PushService';
import { PushCoordinator } from './push/PushCoordinator';
import { createPushStorage } from './store/persistence/createPushStorage';

interface ApplicationDependencies {
  logger: Logger;
  config: Config;
  records: IRecordStore;
  registrationStore: RegistrationStore;
  serviceWatcher: ServiceWatcher;
  pushService: PushService;
  pushCoordinator: PushCoordinator;
  udpProxy: UdpProxy;
  tlsProxy: TlsProxy;
  tcpProxy: TcpProxy;
  apiServer: ApiServer;
  proxyInitializer: ProxyInitializer;
}

// The composition root owns implementation choices; services receive their dependencies.
const container = createContainer<ApplicationDependencies>({ injectionMode: InjectionMode.PROXY });

container.register({
  logger: asClass(ConsoleLogger).singleton(),
  config: asClass(Config).singleton(),
  records: asClass(MemoryStore).singleton(),
  registrationStore: asFunction(({ config, logger }: ApplicationDependencies) => new RegistrationStore(createPushStorage(config), logger)).singleton(),
  serviceWatcher: asFunction(({ records, logger }: ApplicationDependencies) =>
    new DockerWatcher(records, logger)).singleton(),
  pushService: asFunction(({ config }: ApplicationDependencies) => new PushService(config)).singleton(),
  pushCoordinator: asFunction(({ registrationStore, pushService, logger }: ApplicationDependencies) =>
    new PushCoordinator(registrationStore, pushService, logger)).singleton(),
  udpProxy: asFunction(({ records, config, logger, registrationStore, pushCoordinator }: ApplicationDependencies) =>
    new UdpProxy(records, config, logger, registrationStore, { pushCoordinator })).singleton(),
  tcpProxy: asFunction(({ records, config, logger, registrationStore, pushCoordinator }: ApplicationDependencies) =>
    new TcpProxy(records, config, logger, registrationStore, { pushCoordinator })).singleton(),
  tlsProxy: asFunction(({ records, config, logger, registrationStore, pushCoordinator }: ApplicationDependencies) =>
    new TlsProxy(records, config, logger, registrationStore, { pushCoordinator })).singleton(),
  apiServer: asFunction(({ config, logger, records, registrationStore }: ApplicationDependencies) =>
    new ApiServer(config, logger, records, () => registrationStore.storageHealthy)).singleton(),
  proxyInitializer: asFunction(({ udpProxy, config, logger }: ApplicationDependencies) =>
    // Keep TLS lazy: loading certificates is only valid when TLS is enabled.
    new ProxyInitializer(udpProxy, () => container.resolve('tlsProxy'), config, logger, () => container.resolve('tcpProxy'))).singleton(),
});

export { container };
