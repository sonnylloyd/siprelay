import { Config } from './configurations';
import { ConsoleLogger } from './logging';
import { Logger } from './logging/Logger';
import { TlsProxy } from './proxies/TlsProxy';
import { UdpProxy } from './proxies/UdpProxy';
import { ApiServer } from './http';
import { ServiceWatcher } from './watchers/ServiceWatcher';
import { ProxyInitializer } from './bootstrap/ProxyInitializer';
import { container } from './container';
import * as fs from 'fs';

const logger = container.resolve<Logger>('logger');
const config = container.resolve<Config>('config');

// Initialize Service Watcher to dynamically update PBX records
const serviceWatcher = container.resolve<ServiceWatcher>('serviceWatcher');
serviceWatcher.watch();

// Initialize Proxies
const proxyInitializer = container.resolve<ProxyInitializer>('proxyInitializer');
proxyInitializer.start();

// Start the API server
const apiServer = container.resolve<ApiServer>('apiServer');
apiServer.start();

// Graceful shutdown handling
process.on('SIGINT', () => {
  logger.info('Shutting down SIP Relay...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down SIP Relay...');
  process.exit(0);
});
