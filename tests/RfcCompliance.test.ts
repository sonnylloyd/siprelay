import { describe, expect, it, vi } from 'vitest';
import { SipMessage, SipFrameDecoder } from '../src/sip';
import { checkProxyRequest } from '../src/sip/ProxyRequestPolicy';
import { sipRequest } from './fixtures/sip';

describe('RFC 3261 syntax and forwarding regressions', () => {
  it('accepts extension method tokens without changing their case', () => {
    const message = sipRequest(); message.startLine = 'X-probe sip:alice@pbx.internal SIP/2.0';
    message.setHeader('CSeq', '7 X-probe');
    expect(message.isValid()).toBe(true); expect(message.getMethod()).toBe('X-probe');
    expect(message.getCSeqMethod()).toBe('X-probe');
    const before = message.getTransactionKey(); message.setHeader('CSeq', '7 X-PROBE');
    expect(message.isValid()).toBe(false); expect(message.getTransactionKey()).not.toBe(before);
  });

  it('accepts case-insensitive SIP version spelling and serializes its canonical form', () => {
    const message = new SipMessage(sipRequest().toString().replace('SIP/2.0\r\n', 'sip/2.0\r\n'));
    expect(message.isValid()).toBe(true); expect(message.startLine).toContain(' SIP/2.0');
    const response = new SipMessage('sip/2.0 200 OK\r\n\r\n'); expect(response.isResponse()).toBe(true);
  });

  it('supports the remaining core compact headers and horizontal whitespace', () => {
    const raw = sipRequest().toString().replace('Content-Length: 0', 's: a subject\r\nk: timer, 100rel\r\ne: identity\r\nX-Trace:\tfirst\tsecond\r\nContent-Length: 0');
    const message = new SipMessage(raw); expect(message.isValid()).toBe(true);
    expect(message.getFirstHeader('Subject')).toBe('a subject');
    expect(message.getFirstHeader('Supported')).toBe('timer, 100rel');
    expect(message.getFirstHeader('Content-Encoding')).toBe('identity');
    expect(message.getFirstHeader('X-Trace')).toBe('first\tsecond');
  });

  it('rejects unimplemented Proxy-Require options with an Unsupported list', () => {
    const message = sipRequest(); message.setHeader('Proxy-Require', ['outbound, proprietary', 'outbound']);
    const rejection = checkProxyRequest(message, 'TLS');
    expect(rejection).toEqual({ status: 420, reason: 'Bad Extension', headers: { Unsupported: 'outbound, proprietary' } });
    const response = new SipMessage(message.createResponse(rejection!.status, rejection!.reason, rejection!.headers));
    expect(response.getFirstHeader('Unsupported')).toBe('outbound, proprietary'); expect(response.getFirstHeader('CSeq')).toBe('1 INVITE');
  });

  it.each(['', 'bad option', 'outbound,'])('rejects malformed Proxy-Require value %s', value => {
    const message = sipRequest(); message.setHeader('Proxy-Require', value);
    expect(checkProxyRequest(message, 'TLS')?.status).toBe(400);
  });

  it.each(['ACK', 'CANCEL'])('ignores Proxy-Require on %s', method => {
    const message = sipRequest({ method }); message.setHeader('Proxy-Require', 'unknown');
    expect(checkProxyRequest(message, 'TLS')).toBeUndefined();
  });

  it('passes endpoint Require through without claiming proxy support', () => {
    const message = sipRequest(); message.setHeader('Require', '100rel');
    expect(checkProxyRequest(message, 'TLS')).toBeUndefined(); expect(message.getFirstHeader('Require')).toBe('100rel');
  });

  it.each(['-1', '256', 'garbage', '1.5'])('rejects malformed Max-Forwards %s as a syntax error', value => {
    const message = sipRequest(); message.setHeader('Max-Forwards', value);
    expect(checkProxyRequest(message, 'UDP')?.status).toBe(400);
  });

  it('distinguishes a zero hop budget from malformed or absent Max-Forwards', () => {
    const message = sipRequest(); message.setHeader('Max-Forwards', ['70', '70']);
    expect(checkProxyRequest(message, 'TLS')?.status).toBe(400);
    message.setHeader('Max-Forwards', '0'); expect(checkProxyRequest(message, 'TLS')).toBeUndefined();
    expect(message.decrementMaxForwards()).toBe(false);
    message.removeHeader('Max-Forwards'); expect(checkProxyRequest(message, 'TLS')).toBeUndefined();
    expect(message.decrementMaxForwards()).toBe(true); expect(message.getFirstHeader('Max-Forwards')).toBe('70');
  });

  it('returns an explicit unsupported-scheme error', () => {
    const message = sipRequest(); message.startLine = 'INVITE tel:+441234567890 SIP/2.0';
    expect(checkProxyRequest(message, 'TLS')?.status).toBe(416);
  });
});

describe('RFC 3581 symmetric response routing', () => {
  it('uses the actual source port for rport, otherwise the sent-by/default SIP port', () => {
    const message = sipRequest(); message.setReceived('192.0.2.10', 55000);
    expect(message.getUdpResponsePort(55000)).toBe(55000);
    expect(message.getTopVia()).toContain(';rport=55000'); expect(message.getTopVia()).toContain(';received=192.0.2.10');
    message.setHeader('Via', 'SIP/2.0/UDP phone.example:5090;branch=one');
    expect(message.getUdpResponsePort(55000)).toBe(5090);
    message.setHeader('Via', 'SIP/2.0/UDP [2001:db8::1];branch=one');
    expect(message.getUdpResponsePort(55000)).toBe(5060);
    message.setHeader('Via', 'SIP/2.0/UDP phone.example:99999;branch=one');
    expect(message.getUdpResponsePort(55000)).toBe(5060);
    message.removeHeader('Via'); expect(message.getUdpResponsePort(55000)).toBe(5060);
  });
});

describe('RFC 5626 CRLF keepalive framing', () => {
  it('recognizes a double CRLF at every byte boundary and does not treat pong as ping', () => {
    for (let split = 0; split <= 4; split++) {
      const decoder = new SipFrameDecoder(), ping = vi.fn(); const bytes = Buffer.from('\r\n\r\n');
      expect(decoder.feed(bytes.subarray(0, split), ping)).toEqual([]);
      expect(decoder.feed(bytes.subarray(split), ping)).toEqual([]); expect(ping).toHaveBeenCalledOnce();
    }
    const ping = vi.fn(); new SipFrameDecoder().feed('\r\n', ping); expect(ping).not.toHaveBeenCalled();
  });

  it('does not consume body CRLF as keepalive and accepts folded Content-Length', () => {
    const message = sipRequest({ body: '\r\n\r\n' }); const ping = vi.fn();
    const raw = message.toString().replace('Content-Length: 4', 'Content-Length:\r\n\t4');
    expect(new SipFrameDecoder().feed(raw, ping)).toEqual([raw]); expect(ping).not.toHaveBeenCalled();
  });
});

describe('RFC 5630 secure routing intent', () => {
  it('rejects SIPS on the UDP-only path and preserves SIPS Record-Route on TLS', () => {
    const message = sipRequest(); message.startLine = 'INVITE sips:alice@pbx.internal SIP/2.0';
    expect(checkProxyRequest(message, 'UDP')?.status).toBe(416);
    expect(checkProxyRequest(message, 'TLS')).toBeUndefined();
    message.addRecordRoute('pbx.internal', 'relay', 5061, 'TLS');
    expect(message.getFirstHeader('Record-Route')).toContain('<sips:relay:5061;');
  });

  it('remembers SIPS after consuming its own loose Route', () => {
    const message = sipRequest(); message.setHeader('Route', '<sips:relay;lr;sr-domain=pbx.internal>');
    expect(checkProxyRequest(message, 'UDP')?.status).toBe(416);
    expect(message.takeProxyRoute('relay')).toBe('pbx.internal'); expect(message.requiresSecureTransport()).toBe(true);
    message.addRecordRoute('pbx.internal', 'relay', 5061, 'TLS');
    expect(message.getFirstHeader('Record-Route')).toContain('<sips:');
    expect(new SipMessage('SIP/2.0 200 OK\r\n\r\n').requiresSecureTransport()).toBe(false);
  });
});

describe('RFC 3261 octet-preserving transport', () => {
  it('preserves binary MIME bodies and uses byte lengths rather than a UTF-8 round-trip', () => {
    const body = Buffer.from([0xff, 0xfe, 0x00, 0x80, 13, 10, 13, 10]);
    const header = sipRequest().toString().replace('Content-Length: 0', `Content-Type: application/octet-stream\r\nContent-Length: ${body.length}`);
    const wire = Buffer.concat([Buffer.from(header), body]);
    const message = new SipMessage(wire); expect(message.isValid()).toBe(true);
    expect(message.toBuffer().subarray(-body.length)).toEqual(body);
    const decoder = new SipFrameDecoder();
    expect(decoder.feedBuffers(wire.subarray(0, wire.length - 3))).toEqual([]);
    expect(decoder.feedBuffers(wire.subarray(wire.length - 3))).toEqual([wire]);
  });

  it('discards extra datagram bytes but rejects truncated bodies and duplicate lengths', () => {
    const wire = sipRequest().toString() + 'trailing bytes';
    expect(new SipMessage(wire).isValid()).toBe(false);
    const datagram = new SipMessage(Buffer.from(wire), { datagram: true });
    expect(datagram.isValid()).toBe(true); expect(datagram.body).toBe('');
    const truncated = wire.replace('Content-Length: 0', 'Content-Length: 999');
    expect(new SipMessage(truncated, { datagram: true }).isValid()).toBe(false);
    const duplicate = wire.replace('Content-Length: 0', 'Content-Length: 0\r\nl: 1');
    expect(new SipMessage(duplicate, { datagram: true }).isValid()).toBe(false);
  });

  it('continues supporting explicit UTF-8 body edits through the text view', () => {
    const message = sipRequest(); message.body = '☎';
    expect(message.body).toBe('☎'); message.toBuffer(); expect(message.getFirstHeader('Content-Length')).toBe('3');
  });
});


it('matches numerically equal CSeq values while retaining case-sensitive methods', () => {
  const one = sipRequest(), padded = sipRequest(); padded.setHeader('CSeq', '0001 INVITE');
  expect(padded.isValid()).toBe(true); expect(padded.getCSeqNumber()).toBe('1');
  expect(padded.getTransactionKey()).toBe(one.getTransactionKey());
});

it('rejects a malformed SIP target before route lookup', () => {
  const message = sipRequest(); message.startLine = 'INVITE sip:@@invalid SIP/2.0';
  expect(checkProxyRequest(message, 'UDP')?.status).toBe(400);
});

it('rejects undecodable tenant routing and preserves secure routing in deferred copies', () => {
  const invalid = sipRequest(); invalid.setHeader('Route', '<sip:relay;lr;sr-domain=%FF>');
  expect(invalid.takeProxyRoute('relay')).toBeUndefined();
  const secure = sipRequest(); secure.setHeader('Route', '<sips:relay;lr;sr-domain=pbx.internal>');
  secure.takeProxyRoute('relay');
  const copy = secure.clone(); expect(copy.requiresSecureTransport()).toBe(true);
  copy.addRecordRoute('pbx.internal', 'relay', 5061, 'TLS');
  expect(copy.getFirstHeader('Record-Route')).toContain('<sips:');
});
