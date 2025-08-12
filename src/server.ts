import { Config } from './configurations';
import { MemoryStore } from './store';
import { DockerWatcher } from './watchers';
import { ConsoleLogger } from './logging';
import { TlsProxy, UdpProxy } from './proxies';
import { RtpManager } from './media';
import { ApiServer } from './http';
import * as fs from 'fs';

// Initialize logger
const logger = new ConsoleLogger();

// Load configurations
const config = new Config();

// Initialize PBX Records store
const records = new MemoryStore();

// Initialize rtp manager
const rtpManager = new RtpManager(logger);

// Initialize Docker Watcher to dynamically update PBX records
const dockerWatcher = new DockerWatcher(records, logger);
dockerWatcher.watch();

// Initialize Proxies
const udpProxy = new UdpProxy(records, config, logger, rtpManager);
udpProxy.start();

// Check if TLS key and cert files exist, if so, start the TLS proxy
if (fs.existsSync(config.SIP_TLS_KEY_PATH) && fs.existsSync(config.SIP_TLS_CERT_PATH)) {
  logger.info('TLS key and certificate found. Starting TLS proxy...');
  const tlsProxy = new TlsProxy(records, config, logger);
  tlsProxy.start();
} else {
  logger.info('TLS key and certificate not found. Skipping TLS proxy.');
}

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
