import { SipTransport } from '../constants/transport';
import { SipMessage } from './SipMessage';
import { parseSipUri } from './SipUri';

export interface ProxyRejection {
  status: number;
  reason: string;
  headers?: Readonly<Record<string, string>>;
}

/** Common forwarding checks. No Proxy-Require extensions are implemented or advertised. */
export function checkProxyRequest(message: SipMessage, transport: SipTransport, registrationMode: 'path' | 'contact' = 'contact'): ProxyRejection | undefined {
  const target = message.startLine.split(/\s+/)[1] ?? '';
  if (!/^sips?:/i.test(target) || (transport !== 'TLS' && message.requiresSecureTransport())) {
    return { status: 416, reason: 'Unsupported URI Scheme' };
  }
  if (!parseSipUri(target)) return { status: 400, reason: 'Bad Request' };
  if (registrationMode === 'path' && message.getMethod() === 'REGISTER' && message.getContactHeaders().length
    && message.getContactHeaders()[0] !== '*' && !message.getHeader('Supported').some(value => value.split(',').some(tag => tag.trim().toLowerCase() === 'path'))) {
    return { status: 421, reason: 'Extension Required', headers: { Require: 'path' } };
  }
  const hops = message.getHeader('Max-Forwards');
  if (hops.length > 1 || (hops.length === 1 && (!/^\d+$/.test(hops[0]) || Number(hops[0]) > 255))) {
    return { status: 400, reason: 'Bad Request' };
  }
  // RFC 3261 section 8.2.2.3: ignore these requirements on CANCEL and non-2xx ACK.
  // No successful initial request could have negotiated an unsupported option here.
  if (message.getMethod() === 'ACK' || message.getMethod() === 'CANCEL') return;
  const requirements = message.getHeader('Proxy-Require').flatMap(value => value.split(',').map(tag => tag.trim()));
  if (!requirements.length) return;
  if (requirements.some(tag => !/^[A-Za-z0-9.!%*_+`'~-]+$/.test(tag))) {
    return { status: 400, reason: 'Bad Request' };
  }
  return { status: 420, reason: 'Bad Extension', headers: { Unsupported: [...new Set(requirements)].join(', ') } };
}
