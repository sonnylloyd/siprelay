import { describe, expect, it } from 'vitest';
import { SipFrameDecoder, SipFrameDecoderError, SipFrameDecoderErrorCode } from '../src/sip/SipFrameDecoder';

const buildFrame = (body: string): string =>
  [
    'INVITE sip:alice@example.com SIP/2.0',
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}`,
    '',
    body,
  ].join('\r\n');

describe('SipFrameDecoder', () => {
  it('decodes multiple frames from a single buffer', () => {
    const decoder = new SipFrameDecoder();
    const payload = buildFrame('one') + buildFrame('two');
    const frames = decoder.feed(payload);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain('one');
    expect(frames[1]).toContain('two');
  });

  it('treats missing Content-Length as zero', () => {
    const decoder = new SipFrameDecoder();
    const payload = ['OPTIONS sip:example.com SIP/2.0', '', ''].join('\r\n');
    const frames = decoder.feed(payload);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('OPTIONS');
  });

  it('treats non-numeric Content-Length as missing', () => {
    const decoder = new SipFrameDecoder();
    const payload = ['INVITE sip:example.com SIP/2.0', 'Content-Length: abc', '', ''].join('\r\n');
    const frames = decoder.feed(payload);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('INVITE');
  });

  it('rejects oversized messages', () => {
    const decoder = new SipFrameDecoder({ maxMessageBytes: 10 });
    const payload = buildFrame('01234567890');
    expect(() => decoder.feed(payload)).toThrowError(SipFrameDecoderError);
  });

  it('rejects buffer overflow', () => {
    const decoder = new SipFrameDecoder({ maxBufferBytes: 8 });
    expect(() => decoder.feed('0123456789')).toThrowError(SipFrameDecoderError);
  });
});
