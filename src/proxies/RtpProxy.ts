// media/MediaProxy.ts

import { Logger } from '../logging/Logger';
import { RtpSession, MediaEndpoint } from '../media';

export class RtpProxy {
  private activeSessions: Map<string, RtpSession> = new Map();

  constructor(private logger: Logger) {}

  public createSession(callId: string, sdpA: string, sdpB: string): boolean {
    const endpointA = MediaEndpoint.fromSdp(sdpA);
    const endpointB = MediaEndpoint.fromSdp(sdpB);

    if (!endpointA || !endpointB) {
      this.logger.error(`Failed to parse SDP for Call-ID ${callId}`);
      return false;
    }

    const session = new RtpSession(endpointA, endpointB, this.logger);
    session.start();
    this.activeSessions.set(callId, session);
    return true;
  }

  public endSession(callId: string) {
    const session = this.activeSessions.get(callId);
    if (session) {
      session.stop();
      this.activeSessions.delete(callId);
    } else {
      this.logger.warn(`No active RTP session found for Call-ID ${callId}`);
    }
  }
}