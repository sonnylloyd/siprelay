export const SipFrameDecoderErrorCode = {
  BUFFER_OVERFLOW: 'BUFFER_OVERFLOW',
  INVALID_CONTENT_LENGTH: 'INVALID_CONTENT_LENGTH',
  MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
} as const;

export type SipFrameDecoderErrorCode =
  (typeof SipFrameDecoderErrorCode)[keyof typeof SipFrameDecoderErrorCode];

export class SipFrameDecoderError extends Error {
  public readonly code: SipFrameDecoderErrorCode;

  constructor(code: SipFrameDecoderErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class SipFrameDecoder {
  private buffer = Buffer.alloc(0);
  private keepaliveLine = false;
  private readonly maxMessageBytes: number;
  private readonly maxBufferBytes: number;
  private readonly headerDelimiter = Buffer.from('\r\n\r\n');

  constructor(options: { maxMessageBytes?: number; maxBufferBytes?: number } = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024;
    this.maxBufferBytes = options.maxBufferBytes ?? 256 * 1024;
  }

  public feed(chunk: Buffer | string, onKeepalivePing?: () => void): string[] {
    return this.feedBuffers(chunk, onKeepalivePing).map(frame => frame.toString());
  }

  public feedBuffers(chunk: Buffer | string, onKeepalivePing?: () => void): Buffer[] {
    const nextChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (this.buffer.length + nextChunk.length > this.maxBufferBytes) {
      throw new SipFrameDecoderError(
        SipFrameDecoderErrorCode.BUFFER_OVERFLOW,
        `Buffered data exceeded ${this.maxBufferBytes} bytes`
      );
    }
    if (nextChunk.length) {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, nextChunk]) : nextChunk;
    }

    const messages: Buffer[] = [];

    while (true) {
      // RFC 3261 allows leading CRLF between messages, including fragmented CRLF.
      while (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
        this.buffer = this.buffer.subarray(2);
        this.keepaliveLine = !this.keepaliveLine;
        if (!this.keepaliveLine) onKeepalivePing?.();
      }
      if (this.buffer.length && this.buffer[0] !== 13) this.keepaliveLine = false;
      const headerEnd = this.buffer.indexOf(this.headerDelimiter);
      if (headerEnd === -1) {
        if (this.buffer.length > this.maxMessageBytes) {
          throw new SipFrameDecoderError(SipFrameDecoderErrorCode.MESSAGE_TOO_LARGE, 'SIP headers exceed message limit');
        }
        break;
      }

      const headers = this.buffer.slice(0, headerEnd).toString();
      const contentLength = this.parseContentLength(headers);
      if (contentLength === null) {
        throw new SipFrameDecoderError(
          SipFrameDecoderErrorCode.INVALID_CONTENT_LENGTH,
          'Invalid Content-Length header'
        );
      }
      if (contentLength > this.maxMessageBytes) {
        throw new SipFrameDecoderError(
          SipFrameDecoderErrorCode.MESSAGE_TOO_LARGE,
          `Content-Length ${contentLength} exceeds limit ${this.maxMessageBytes}`
        );
      }

      const totalLength = headerEnd + 4 + contentLength;
      if (totalLength > this.maxMessageBytes) {
        throw new SipFrameDecoderError(
          SipFrameDecoderErrorCode.MESSAGE_TOO_LARGE,
          `SIP frame size ${totalLength} exceeds limit ${this.maxMessageBytes}`
        );
      }

      if (this.buffer.length < totalLength) break;

      messages.push(Buffer.from(this.buffer.subarray(0, totalLength)));
      this.buffer = this.buffer.subarray(totalLength);
    }

    return messages;
  }

  private parseContentLength(headers: string): number | null {
    const lengths = headers.replace(/\r\n[ \t]+/g, ' ').split('\r\n').slice(1)
      .filter(line => /^(?:Content-Length|l)\s*:/i.test(line))
      .map(line => line.slice(line.indexOf(':') + 1).trim());
    // A stream needs an unambiguous boundary; aliases count as duplicates too.
    if (lengths.length !== 1 || !/^\d+$/.test(lengths[0])) return null;
    const len = Number(lengths[0]);
    return Number.isSafeInteger(len) ? len : null;
  }
}
