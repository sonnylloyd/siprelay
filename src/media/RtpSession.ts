// media/RtpSession.ts

import dgram, { Socket } from 'dgram';
import { Logger } from '../logging/Logger';
import { MediaEndpoint } from './MediaEndpoint';
import { EventEmitter } from 'events';

export class RtpSession extends EventEmitter {
  private socketA: Socket;
  private socketB: Socket;

  private lastActivity: number;
  private inactivityTimer?: NodeJS.Timeout;
  private readonly INACTIVITY_TIMEOUT_MS = 30000;

  constructor(
    public endpointA: MediaEndpoint,
    public endpointB: MediaEndpoint,
    private logger: Logger
  ) {
    super();
    this.socketA = dgram.createSocket('udp4');
    this.socketB = dgram.createSocket('udp4');
    this.lastActivity = Date.now();
  }

  public start() {
    this.logger.info(`Starting RTP session between ${this.endpointA.address}:${this.endpointA.port} <-> ${this.endpointB.address}:${this.endpointB.port}`);

    this.socketA.on('message', (msg) => {
      this.lastActivity = Date.now();
      this.socketB.send(msg, this.endpointB.port, this.endpointB.address);
    });

    this.socketB.on('message', (msg) => {
      this.lastActivity = Date.now();
      this.socketA.send(msg, this.endpointA.port, this.endpointA.address);
    });

    this.socketA.bind(this.endpointA.port);
    this.socketB.bind(this.endpointB.port);

    this.inactivityTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > this.INACTIVITY_TIMEOUT_MS) {
        this.logger.warn(`RTP session inactive for ${this.INACTIVITY_TIMEOUT_MS / 1000} seconds. Cleaning up.`);
        this.stop();
        this.emit('timeout');
      }
    }, 5000);
  }

  public stop() {
    this.logger.info(`Stopping RTP session between ${this.endpointA.address}:${this.endpointA.port} <-> ${this.endpointB.address}:${this.endpointB.port}`);
    clearInterval(this.inactivityTimer);
    this.socketA.close();
    this.socketB.close();
  }

  public setDestination(endpoint: MediaEndpoint) {
    this.endpointB = endpoint;
    this.logger.info(`Updated endpointB to ${endpoint.address}:${endpoint.port}`);
  }
}