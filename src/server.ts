import { container } from './container';

const logger = container.resolve('logger');
const registrations = container.resolve('registrationStore');

async function main(): Promise<void> {
  // Restore the private route key and accepted push bindings before receiving SIP.
  await registrations.initialize();
  container.resolve('serviceWatcher').watch();
  container.resolve('proxyInitializer').start();
  container.resolve('apiServer').start();
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down SIP Relay...');
  const deadline = setTimeout(() => { logger.error('Push storage shutdown timed out'); process.exit(1); }, 10_000);
  try { await registrations.close(); clearTimeout(deadline); process.exit(0); }
  catch { logger.error('Push storage shutdown failed'); process.exit(1); }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
void main().catch(() => { logger.error('SIPRelay startup failed; check configuration and push storage availability'); process.exit(1); });
