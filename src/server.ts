import { Config } from './configurations';
import { MemoryStore } from './store';
import { DockerWatcher } from './watchers';
import { ConsoleLogger } from './logging';
import { TlsProxy } from './proxies/TlsProxy';
import { UdpProxy } from './proxies/UdpProxy';
import { ApiServer } from './http';

// Initialize logger
const logger = new ConsoleLogger();

// Load configurations
const config = new Config();

// Initialize PBX Records store
const records = new MemoryStore();

// Initialize Docker Watcher to dynamically update PBX records
const dockerWatcher = new DockerWatcher(records, logger);
dockerWatcher.watch();

// Initialize Proxies
//const tlsProxy = new TlsProxy(records, config, logger);
const udpProxy = new UdpProxy(records, config, logger);

// Start the proxies
//tlsProxy.start();
udpProxy.start();

// Start the API server
const apiServer = new ApiServer(config.HTTP_PORT, logger);
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
