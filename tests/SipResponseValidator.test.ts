import type tls from 'tls';
import { describe, expect, it } from 'vitest';
import { SipMessage } from '../src/sip/SipMessage';
import { SipResponseValidator } from '../src/sip/SipResponseValidator';
import { createTestLogger } from './utils';

const buildResponse = (viaBranch = 'z9hG4bK-xyz'): SipMessage =>
  new SipMessage(
    [
      'SIP/2.0 200 OK',
      `Via: SIP/2.0/UDP 203.0.113.5:15060;branch=${viaBranch}`,
      'Call-ID: resp123',
      'CSeq: 1 INVITE',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n')
  );

describe('SipResponseValidator', () => {
  it('rejects responses missing Call-ID', () => {
    const validator = new SipResponseValidator(createTestLogger());
    const msg = buildResponse();
    msg.removeHeader('Call-ID');
    const result = validator.validate({ sipMessage: msg });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('missing Call-ID');
  });

  it('rejects mismatched upstream keys', () => {
    const validator = new SipResponseValidator(createTestLogger());
    const msg = buildResponse();
    const result = validator.validate({
      callId: 'resp123',
      expectedUpstreamKey: 'udp:1.1.1.1:5060',
      actualUpstreamKey: 'udp:2.2.2.2:5060',
      sipMessage: msg,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects responses on unexpected sockets', () => {
    const validator = new SipResponseValidator(createTestLogger());
    const msg = buildResponse();
    const expected = {} as tls.TLSSocket;
    const actual = {} as tls.TLSSocket;
    const result = validator.validate({
      callId: 'resp123',
      expectedSocket: expected,
      actualSocket: actual,
      sipMessage: msg,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts valid responses', () => {
    const validator = new SipResponseValidator(createTestLogger());
    const msg = buildResponse('branch-ok');
    const result = validator.validate({
      callId: 'resp123',
      expectedProxyBranch: 'branch-ok',
      sipMessage: msg,
    });
    expect(result.ok).toBe(true);
  });
});
