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
