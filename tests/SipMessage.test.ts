import { describe, expect, it } from 'vitest';
import { SipMessage } from '../src/sip/SipMessage';

const buildRequest = (): string =>
  [
    'INVITE sip:alice@example.com SIP/2.0',
    'Via: SIP/2.0/UDP 198.51.100.10:5090;branch=z9hG4bK-abc;rport',
    'To: <sip:alice@example.com>',
    'From: <sip:bob@example.net>;tag=123',
    'Call-ID: abc123',
    'CSeq: 1 INVITE',
    'Contact: <sip:bob@198.51.100.10:5060>',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

const buildResponse = (): string =>
  [
    'SIP/2.0 200 OK',
    'Via: SIP/2.0/UDP 203.0.113.5:15060;branch=z9hG4bK-xyz',
    'Call-ID: resp123',
    'CSeq: 1 INVITE',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');

describe('SipMessage', () => {
  it('parses request metadata and headers', () => {
    const msg = new SipMessage(buildRequest());
    expect(msg.isResponse()).toBe(false);
    expect(msg.getMethod()).toBe('INVITE');
    expect(msg.getCallId()).toBe('abc123');
    expect(msg.getCSeqMethod()).toBe('INVITE');
    expect(msg.getTargetHost()).toBe('example.com');
    expect(msg.getTargetUser()).toBe('alice');
    expect(msg.getAddressOfRecord()).toEqual({ user: 'alice', host: 'example.com' });
    expect(msg.getContactHeaders()[0]).toContain('198.51.100.10:5060');
    expect(msg.getTopVia()).toContain('branch=z9hG4bK-abc');
    expect(msg.getBranchFromVia(msg.getTopVia()!)).toBe('z9hG4bK-abc');
    expect(msg.hasRPort(msg.getTopVia()!)).toBe(true);
  });

  it('parses response metadata', () => {
    const msg = new SipMessage(buildResponse());
    expect(msg.isResponse()).toBe(true);
    expect(msg.getMethod()).toBeUndefined();
    expect(msg.getStatusCode()).toBe(200);
  });

  it('updates Contact and Content-Length when serialized', () => {
    const msg = new SipMessage(buildRequest());
    msg.updateContact('203.0.113.5', 15060);
    const serialized = msg.toString();
    expect(serialized).toContain('Contact: <sip:bob@203.0.113.5:15060>');
    expect(serialized).toContain('Content-Length: 0');
  });

  it('generates branch values with the RFC prefix', () => {
    const msg = new SipMessage(buildRequest());
    const branch = msg.generateBranch();
    expect(branch.startsWith('z9hG4bK')).toBe(true);
  });
});

describe('SIP interoperability regressions', () => {
  it('accepts case-insensitive and compact header names without duplicate lengths', () => {
    const message = new SipMessage(buildRequest().replace('Via:', 'v:').replace('Call-ID:', 'i:').replace('To:', 't:').replace('Content-Length:', 'l:'));
    expect(message.getCallId()).toBe('abc123');
    expect(message.getAddressOfRecord()?.user).toBe('alice');
    expect(message.getTopVia()).toContain('z9hG4bK-abc');
    expect(message.toString().match(/Content-Length:/g)).toHaveLength(1);
  });

  it.each(['sip:alice@EXAMPLE.COM:5060;transport=udp', 'sips:alice@example.com:5061'])('extracts domains from %s', uri => {
    const message = new SipMessage(buildRequest().replace('sip:alice@example.com SIP/2.0', `${uri} SIP/2.0`));
    expect(message.getTargetHost()).toBe('example.com');
  });

  it('preserves Contact URI and push parameters when rewriting the authority', () => {
    const message = new SipMessage(buildRequest());
    message.setHeader('Contact', '<sips:bob@192.0.2.1:5061;transport=tls;pn-provider=apns;pn-prid=abcdef;pn-param=app.voip>;expires=120');
    message.updateContact('203.0.113.5', 5061);
    expect(message.getContactHeaders()[0]).toBe('<sips:bob@203.0.113.5:5061;transport=tls;pn-provider=apns;pn-prid=abcdef;pn-param=app.voip>;expires=120');
  });

  it('removes exactly one Via from a comma-separated list', () => {
    const message = new SipMessage(buildResponse());
    message.setHeader('Via', ['proxy, original;branch=z9hG4bK-client', 'other']);
    message.removeViaTop();
    expect(message.getHeader('Via')).toEqual(['original;branch=z9hG4bK-client', 'other']);
  });

  it('uses stable proxy branches for retransmissions and CANCEL, and distinguishes CSeq transactions', () => {
    const request = new SipMessage(buildRequest());
    expect(new SipMessage(buildRequest()).generateBranch()).toBe(request.generateBranch());
    expect(new SipMessage(buildRequest().replaceAll('INVITE', 'CANCEL')).generateBranch()).toBe(request.generateBranch());
    expect(new SipMessage(buildRequest().replace('CSeq: 1', 'CSeq: 2')).getTransactionKey()).not.toBe(request.getTransactionKey());
  });

  it('fills received and rport without discarding other Via parameters', () => {
    const message = new SipMessage(buildRequest().replace(';rport', ';rport;alias'));
    message.setReceived('192.0.2.5', 55000);
    expect(message.getTopVia()).toContain(';rport=55000;alias;received=192.0.2.5');
    expect(message.decrementMaxForwards()).toBe(true);
    expect(message.getFirstHeader('Max-Forwards')).toBe('70');
    message.setHeader('Max-Forwards', '0');
    expect(message.decrementMaxForwards()).toBe(false);
  });
  it('unfolds headers and parses Via branches from comma-separated values', () => {
    const message = new SipMessage(buildRequest().replace(';rport', ', SIP/2.0/UDP other;branch=z9hG4bK-other')
      .replace('Contact: <sip:bob@198.51.100.10:5060>', 'Contact: <sip:bob@198.51.100.10:5060;\r\n transport=udp>'));
    expect(message.getBranchFromVia(message.getTopVia()!)).toBe('z9hG4bK-abc');
    expect(message.getContactHeaders()[0]).toBe('<sip:bob@198.51.100.10:5060; transport=udp>');
  });

  it('restores the device Contact without forwarding push tokens as the request URI', () => {
    const message = new SipMessage(buildRequest());
    message.useClientContact('<sip:alice@192.0.2.5:5099;transport=udp;pn-provider=fcm;pn-prid=secret;pn-param=project>;expires=60');
    expect(message.startLine).toBe('INVITE sip:alice@192.0.2.5:5099;transport=udp SIP/2.0');
  });

  it('produces stable To tags on local final-response retransmissions', () => {
    const message = new SipMessage(buildRequest());
    expect(message.createResponse(480, 'Temporarily Unavailable')).toBe(message.createResponse(480, 'Temporarily Unavailable'));
  });

  it('handles extension header names that overlap JavaScript object properties', () => {
    const message = new SipMessage(buildRequest().replace('Content-Length: 0',
      'constructor: extension\r\n__proto__: another-extension\r\nContent-Length: 0'));
    expect(message.getFirstHeader('constructor')).toBe('extension');
    expect(message.getFirstHeader('__proto__')).toBe('another-extension');
    expect(message.toString()).toContain('Constructor: extension');
    expect(message.toString()).toContain('__proto__: another-extension');
  });

});
