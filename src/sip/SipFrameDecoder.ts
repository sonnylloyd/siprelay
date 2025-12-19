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
  private buffer = '';
  private readonly maxMessageBytes: number;
  private readonly maxBufferBytes: number;

  constructor(options: { maxMessageBytes?: number; maxBufferBytes?: number } = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? 64 * 1024;
    this.maxBufferBytes = options.maxBufferBytes ?? 256 * 1024;
  }

  public feed(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString();

    if (this.buffer.length > this.maxBufferBytes) {
      throw new SipFrameDecoderError(
        SipFrameDecoderErrorCode.BUFFER_OVERFLOW,
        `Buffered data exceeded ${this.maxBufferBytes} bytes`
      );
    }

    const messages: string[] = [];

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headers = this.buffer.slice(0, headerEnd);
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

      messages.push(this.buffer.slice(0, totalLength));
      this.buffer = this.buffer.slice(totalLength);
    }

    return messages;
  }

  private parseContentLength(headers: string): number | null {
    const match = headers.match(/Content-Length:\s*(\d+)/i);
    if (!match) return 0;
    const len = Number.parseInt(match[1], 10);
    if (!Number.isFinite(len) || len < 0) return null;
    return len;
  }
}
