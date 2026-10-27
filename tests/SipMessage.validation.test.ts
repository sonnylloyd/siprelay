import { describe, expect, it } from 'vitest';
import { SipMessage } from '../src/sip';
import { parseSipUri, formatSipHost } from '../src/sip/SipUri';
import { sipRequest, sipResponse } from './fixtures/sip';

describe('SIP message rejection boundaries', () => {
  it.each(['Call-ID', 'From', 'To', 'CSeq', 'Via'])('rejects a message missing %s', header => {
    const request = sipRequest(); request.removeHeader(header);
    expect(request.isValid()).toBe(false);
  });

  it.each(['Call-ID', 'From', 'To', 'CSeq'])('rejects duplicate %s fields', header => {
    const request = sipRequest(); request.addHeader(header, request.getFirstHeader(header)!);
    expect(request.isValid()).toBe(false);
  });

  it.each(['', 'NOT SIP', 'INVITE sip:alice@example.com SIP/1.0', 'SIP/2.0 700 Invalid'])
    ('rejects invalid start line %s', startLine => {
      const request = sipRequest(); request.startLine = startLine;
      expect(request.isValid()).toBe(false);
    });

  it.each(['0 BYE', '2147483648 INVITE', '-1 INVITE', 'garbage', '1', '1 invite'])
    ('rejects invalid or mismatched CSeq %s', cseq => {
      const request = sipRequest(); request.setHeader('CSeq', cseq);
      expect(request.isValid()).toBe(false);
    });

  it.each(['-1', 'NaN', '1x', '1', '9007199254740993'])('rejects an invalid body length %s', length => {
    const request = sipRequest(); request.setHeader('Content-Length', length);
    expect(request.isValid()).toBe(false);
  });

  it('counts body bytes rather than characters and allows UDP without a length field', () => {
    const request = sipRequest({ body: 'é☎' });
    expect(request.isValid()).toBe(true);
    request.setHeader('Content-Length', String(request.body.length));
    expect(request.isValid()).toBe(false);
    request.removeHeader('Content-Length');
    expect(request.isValid()).toBe(true);
  });

  it.each(['Malformed header', 'Bad Header: value', ': value'])('rejects malformed header %s', line => {
    const raw = sipRequest().toString().replace('Content-Length: 0', `${line}\r\nContent-Length: 0`);
    expect(new SipMessage(raw).isValid()).toBe(false);
  });

  it('requires a branch on the top Via and rejects conflicting compact lengths', () => {
    const request = sipRequest(); request.setHeader('Via', 'SIP/2.0/UDP client;rport');
    expect(request.isValid()).toBe(false);
    const duplicate = sipRequest().toString().replace('Content-Length: 0', 'l: 0\r\nContent-Length: 0');
    expect(new SipMessage(duplicate).isValid()).toBe(false);
  });

  it('accepts legal CSeq boundaries, response metadata and an existing dialog tag', () => {
    const request = sipRequest({ cseq: 2147483647 });
    expect(request.isValid()).toBe(true);
    const response = sipResponse(request);
    expect(response.isValid()).toBe(true);
    expect(response.getMethod()).toBeUndefined();
    expect(response.getTargetHost()).toBeNull();
    expect(response.getTargetUser()).toBeNull();
    expect(response.isInDialog()).toBe(true);
    expect(new SipMessage(response.createResponse(486, 'Busy Here')).getFirstHeader('To'))
      .toBe(response.getFirstHeader('To'));
  });

  it.each(['0', '-1', '256', '1x', '9007199254740993'])('rejects invalid hop limit %s', hops => {
    const request = sipRequest(); request.setHeader('Max-Forwards', hops);
    expect(request.decrementMaxForwards()).toBe(false);
  });

  it('decrements one hop to zero and rejects duplicate hop limits', () => {
    const request = sipRequest(); request.setHeader('Max-Forwards', '1');
    expect(request.decrementMaxForwards()).toBe(true);
    expect(request.getFirstHeader('Max-Forwards')).toBe('0');
    request.setHeader('Max-Forwards', ['70', '70']);
    expect(request.decrementMaxForwards()).toBe(false);
  });
});

describe('SIP URIs, contacts and loose routes', () => {
  it.each([
    ['sip:alice@example.com:5060;transport=udp', 'example.com', 'alice'],
    ['sips:alice@[2001:db8::1]:5061', '[2001:db8::1]', 'alice'],
    ['sip:PBX.EXAMPLE', 'pbx.example', undefined],
  ])('parses %s', (uri, host, user) => expect(parseSipUri(uri)).toEqual({ host, ...(user ? { user } : {}) }));

  it('returns no address for unsupported URIs and formats IPv6 exactly once', () => {
    expect(parseSipUri('tel:+441234')).toBeNull();
    expect(formatSipHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(formatSipHost('[2001:db8::1]')).toBe('[2001:db8::1]');
    expect(formatSipHost('pbx.example')).toBe('pbx.example');
  });

  it('consumes only its own loose Route and preserves subsequent hops', () => {
    const request = sipRequest();
    request.setHeader('Route', ['<sip:relay.example;lr;sr-domain=PBX.INTERNAL>, <sip:other.example;lr>', '<sip:last.example;lr>']);
    expect(request.takeProxyRoute('RELAY.EXAMPLE')).toBe('pbx.internal');
    expect(request.getHeader('Route')).toEqual(['<sip:other.example;lr>', '<sip:last.example;lr>']);
  });

  it.each([
    '<sip:other.example;lr;sr-domain=pbx.internal>',
    '<sip:relay.example;sr-domain=pbx.internal>',
    '<sip:relay.example;lr>',
    '<sip:relay.example;lr;sr-domain=%broken>',
  ])('does not consume an unsupported Route %s', route => {
    const request = sipRequest(); request.setHeader('Route', route);
    expect(request.takeProxyRoute('relay.example')).toBeUndefined();
    expect(request.getHeader('Route')).toEqual([route]);
  });

  it('adds Record-Route for initial subscriptions but not in-dialog requests or REGISTER', () => {
    const subscribe = sipRequest({ method: 'SUBSCRIBE' });
    subscribe.addRecordRoute('pbx.internal', '2001:db8::1', 5061, 'TLS');
    expect(subscribe.getFirstHeader('Record-Route')).toContain('sip:[2001:db8::1]:5061;transport=tls');
    subscribe.setHeader('To', '<sip:alice@pbx.internal>;tag=existing');
    subscribe.removeHeader('Record-Route');
    subscribe.addRecordRoute('pbx.internal', 'relay', 5061, 'TLS');
    expect(subscribe.getHeader('Record-Route')).toEqual([]);
    const register = sipRequest({ method: 'REGISTER' });
    register.addRecordRoute('pbx.internal', 'relay', 5060, 'UDP');
    expect(register.getHeader('Record-Route')).toEqual([]);
  });

  it('preserves body delimiters and round-trips a valid multibyte body', () => {
    const request = sipRequest({ body: 'v=0\r\n\r\n☎' });
    const reparsed = new SipMessage(request.toString());
    expect(reparsed.body).toBe(request.body);
    expect(reparsed.isValid()).toBe(true);
  });
});
