import { splitNameAddress } from '../sip/SipUri';
import { PushDestination } from './types';

// Tokens belong to the authenticated Contact, never to an incoming INVITE.
export function parsePushDestination(contact?: string): PushDestination | undefined {
  if (!contact) return;
  const uri = splitNameAddress(contact)?.uri;
  if (!uri) return;
  const params = new Map<string, string>();
  try {
    for (const part of uri.split(';').slice(1)) {
      const equals = part.indexOf('=');
      if (equals > 0) params.set(part.slice(0, equals).toLowerCase(), decodeURIComponent(part.slice(equals + 1)));
    }
  } catch { return; }
  const provider = params.get('pn-provider');
  const token = params.get('pn-prid');
  const app = params.get('pn-param');
  if ((provider !== 'apns' && provider !== 'fcm') || !token || !app || token.length > 4096) return;
  if (provider === 'apns' && !/^[a-f\d]+$/i.test(token)) return;
  return { provider, token, app };
}

