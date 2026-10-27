import { describe, expect, it } from 'vitest';
import { SipFrameDecoder, SipFrameDecoderError } from '../src/sip/SipFrameDecoder';

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

  it.each(['', 'Content-Length: abc', 'Content-Length: -1',
    'Content-Length: 1x', 'Content-Length: 0\r\nl: 0',
    'Content-Length: 0\r\nContent-Length: 2'])('rejects ambiguous framing: %s', header => {
    const decoder = new SipFrameDecoder();
    expect(() => decoder.feed(`OPTIONS sip:example.com SIP/2.0\r\n${header}\r\n\r\n`))
      .toThrowError(SipFrameDecoderError);
  });

  it('supports compact lengths and fragmented leading CRLF', () => {
    const decoder = new SipFrameDecoder();
    expect(decoder.feed('\r')).toEqual([]);
    const frames = decoder.feed('\n' + buildFrame('é').replace('Content-Length', 'l'));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('é');
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

describe('stream fragmentation and size boundaries', () => {
  it('decodes every possible two-chunk split of a multibyte frame without corruption', () => {
    const frame = Buffer.from(buildFrame('☎\r\né'));
    for (let split = 0; split <= frame.length; split++) {
      const decoder = new SipFrameDecoder();
      const messages = [...decoder.feed(frame.subarray(0, split)), ...decoder.feed(frame.subarray(split))];
      expect(messages).toEqual([frame.toString()]);
    }
  });

  it('handles byte-at-a-time frames, pipelining and a partial next frame', () => {
    const one = buildFrame('one'); const two = buildFrame('two');
    const decoder = new SipFrameDecoder();
    const messages = [...Buffer.from(one)].flatMap(byte => decoder.feed(Buffer.from([byte])));
    expect(messages).toEqual([one]);
    expect(decoder.feed('\r\n' + two + one.slice(0, 15))).toEqual([two]);
    expect(decoder.feed(one.slice(15))).toEqual([one]);
  });

  it('enforces total message size and unterminated header limits', () => {
    const frame = buildFrame('data');
    expect(new SipFrameDecoder({ maxMessageBytes: Buffer.byteLength(frame) }).feed(frame)).toEqual([frame]);
    expect(() => new SipFrameDecoder({ maxMessageBytes: frame.length - 1 }).feed(frame))
      .toThrowError(SipFrameDecoderError);
    expect(() => new SipFrameDecoder({ maxMessageBytes: 8 }).feed('012345678'))
      .toThrowError('SIP headers exceed message limit');
  });

  it.each(['9007199254740993', '1.5', '+1', '1 trailing'])('rejects a noncanonical stream length %s', length => {
    expect(() => new SipFrameDecoder().feed(buildFrame('').replace('Content-Length: 0', `Content-Length: ${length}`)))
      .toThrowError('Invalid Content-Length header');
  });

  it('does not mistake another header containing Content-Length text for framing', () => {
    const frame = buildFrame('').replace('Content-Length: 0', 'X-Content-Length: 500\r\nContent-Length: 0');
    expect(new SipFrameDecoder().feed(frame)).toEqual([frame]);
  });
});
