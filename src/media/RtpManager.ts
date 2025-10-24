// media/RtpManager.ts
import { RtpSession } from './RtpSession';
import { RtpPortManager } from './RtpPortManager';
import { Logger } from '../logging/Logger';

export class RtpManager {
  private sessions: Map<string, RtpSession>;
  private portManager: RtpPortManager;
  private logger: Logger;

  constructor(logger: Logger, rtpPortRangeStart = 10000, rtpPortRangeEnd = 10100) {
    this.logger = logger;
    this.portManager = new RtpPortManager(rtpPortRangeStart, rtpPortRangeEnd);
    this.sessions = new Map();
  }

  createSession(callId: string, client: { address: string, port: number }, pbx: { address: string, port: number }): RtpSession | null {
    const localPort = this.portManager.allocate();
    if (localPort === null) {
      this.logger.error(`RTP port allocation failed for ${callId}`);
      return null;
    }

    const session = new RtpSession(
        client,    // endpointA
        pbx,       // endpointB
        this.logger
      );
      

    session.start();

    // Clean up on inactivity
    session.on('timeout', () => {
      this.logger.info(`Session timeout for Call-ID ${callId}`);
      this.sessions.delete(callId);
      this.portManager.release(localPort);
    });

    this.sessions.set(callId, session);
    this.logger.info(`Created RTP session on port ${localPort} for Call-ID ${callId}`);

    return session;
  }

  setPbxDestination(callId: string, address: string, port: number): void {
    const session = this.sessions.get(callId);
    if (session) {
      session.setDestination({ address, port });
      this.logger.info(`Updated PBX RTP destination for ${callId} to ${address}:${port}`);
    }
  }

  closeSession(callId: string): void {
    const session = this.sessions.get(callId);
    if (session) {
      session.stop(); // renamed from `close` for clarity and consistency
      this.sessions.delete(callId);
      this.portManager.release(session.endpointA.port); // adjust if needed
      this.logger.info(`Closed RTP session for ${callId}`);
    }
  }

  getSession(callId: string): RtpSession | undefined {
    return this.sessions.get(callId);
  }
}