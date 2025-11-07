import { EventEmitter } from 'events';
import { Logger } from '../logging/Logger';

export interface RtpEndpoint {
  address: string;
  port: number;
}

const DEFAULT_SESSION_TIMEOUT_MS = 30_000;

export class RtpSession extends EventEmitter {
  public endpointA: RtpEndpoint;
  public endpointB: RtpEndpoint;
  private readonly logger: Logger;
  private inactivityTimer?: NodeJS.Timeout;
  private readonly timeoutMs: number;

  constructor(endpointA: RtpEndpoint, endpointB: RtpEndpoint, logger: Logger, timeoutMs = DEFAULT_SESSION_TIMEOUT_MS) {
    super();
    this.endpointA = endpointA;
    this.endpointB = endpointB;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  public start(): void {
    this.logger.info(`Starting RTP session between ${this.describe(this.endpointA)} and ${this.describe(this.endpointB)}`);
    this.resetTimeout();
  }

  public setDestination(endpoint: RtpEndpoint): void {
    this.endpointB = endpoint;
    this.logger.info(`Updated RTP destination to ${this.describe(endpoint)}`);
    this.resetTimeout();
  }

  public stop(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
    this.logger.info('Stopped RTP session');
  }

  private resetTimeout(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    this.inactivityTimer = setTimeout(() => {
      this.logger.warn('RTP session timed out due to inactivity');
      this.emit('timeout');
    }, this.timeoutMs);
  }

  private describe(endpoint: RtpEndpoint): string {
    return `${endpoint.address}:${endpoint.port}`;
  }
}
