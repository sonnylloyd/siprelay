import { SipMessage } from '../../src/sip';

interface RequestOptions {
  method?: string;
  target?: string;
  user?: string;
  domain?: string;
  callId?: string;
  cseq?: number;
  branch?: string;
  transport?: 'UDP' | 'TLS';
  body?: string;
}

export function sipRequest(options: RequestOptions = {}): SipMessage {
  const {
    method = 'INVITE', target = 'alice@pbx.internal', user = 'alice', domain = 'pbx.internal',
    callId = 'test-call', cseq = 1, branch = 'z9hG4bK-phone', transport = 'UDP', body = '',
  } = options;
  return new SipMessage([
    `${method} sip:${target} SIP/2.0`,
    `Via: SIP/2.0/${transport} 198.51.100.10:5090;branch=${branch};rport`,
    'Max-Forwards: 70',
    'From: <sip:bob@example.com>;tag=caller',
    `To: <sip:${user}@${domain}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} ${method}`,
    `Contact: <sip:${user}@198.51.100.10:5090>`,
    ...(body ? ['Content-Type: application/sdp'] : []),
    `Content-Length: ${Buffer.byteLength(body)}`, '', body,
  ].join('\r\n'));
}

export function sipResponse(request: SipMessage, status = 200, reason = 'OK'): SipMessage {
  return new SipMessage([
    `SIP/2.0 ${status} ${reason}`,
    ...request.getHeader('Via').map(via => `Via: ${via}`),
    `From: ${request.getFirstHeader('From')}`,
    `To: ${request.getFirstHeader('To')};tag=callee`,
    `Call-ID: ${request.getCallId()}`,
    `CSeq: ${request.getFirstHeader('CSeq')}`,
    'Content-Length: 0', '', '',
  ].join('\r\n'));
}

export const flushAsync = () => new Promise<void>(resolve => setImmediate(resolve));
