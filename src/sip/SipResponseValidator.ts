import type { Socket } from 'net';
import { Logger } from '../logging/Logger';
import { SipMessage } from './SipMessage';

export interface SipResponseValidationInput {
  callId?: string;
  expectedFromTag?: string;
  expectedToTag?: string;
  expectedUpstreamKey?: string;
  actualUpstreamKey?: string;
  expectedProxyBranch?: string;
  expectedSocket?: Socket;
  actualSocket?: Socket;
  sipMessage: SipMessage;
}

export interface SipResponseValidationResult {
  ok: boolean;
  reason?: string;
}

export class SipResponseValidator {
  constructor(private readonly logger: Logger) {}

  public validate(input: SipResponseValidationInput): SipResponseValidationResult {
    const callId = input.callId ?? 'unknown';

    if (!input.callId) {
      return { ok: false, reason: 'missing Call-ID' };
    }

    if (
      input.expectedUpstreamKey &&
      input.expectedUpstreamKey !== input.actualUpstreamKey
    ) {
      return {
        ok: false,
        reason: `unexpected upstream ${input.actualUpstreamKey} (expected ${input.expectedUpstreamKey})`,
      };
    }

    if (input.expectedSocket && input.expectedSocket !== input.actualSocket) {
      return {
        ok: false,
        reason: 'response arrived on unexpected socket for client',
      };
    }

    if ((input.expectedFromTag && input.sipMessage.getFromTag() !== input.expectedFromTag)
      || (input.expectedToTag && input.sipMessage.getToTag() !== input.expectedToTag)) {
      return { ok: false, reason: 'response dialog tags do not match its request' };
    }

    const topVia = input.sipMessage.getTopVia();
    const viaBranch = topVia ? input.sipMessage.getBranchFromVia(topVia) : undefined;
    if (input.expectedProxyBranch && viaBranch && input.expectedProxyBranch !== viaBranch) {
      return {
        ok: false,
        reason: `Via branch mismatch (expected ${input.expectedProxyBranch}, got ${viaBranch})`,
      };
    }

    if (input.expectedProxyBranch && !viaBranch) {
      return { ok: false, reason: 'Via branch missing on response' };
    }

    this.logger.debug(`Validated SIP response for Call-ID ${callId}`);
    return { ok: true };
  }
}
