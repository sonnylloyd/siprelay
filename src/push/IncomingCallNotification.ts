import crypto from 'crypto';
import { IncomingCallNotification } from './types';

export function createIncomingCallNotification(callId: string): IncomingCallNotification {
  // UUID is suitable for CallKit; Call-ID is preserved for SIP correlation.
  const uuidBytes = crypto.createHash('sha256').update(callId).digest().subarray(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const callUuid = uuidBytes.toString('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
  return { event: 'incoming_call', call_id: callId, call_uuid: callUuid };
}
