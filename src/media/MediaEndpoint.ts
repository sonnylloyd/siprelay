export interface MediaEndpoint {
    address: string;
    port: number;
    protocol: 'RTP' | 'SRTP'; // optional future use
    rtcpPort?: number;
    codec?: string;
    sdpOrigin?: string;
}

export class MediaEndpoint {
    constructor(
      public address: string,
      public port: number,
      public protocol: 'RTP' | 'SRTP' = 'RTP',
      public rtcpPort?: number,
      public codec?: string,
      public sdpOrigin?: string
    ) {}
  
    toString(): string {
      return `${this.protocol}://${this.address}:${this.port}`;
    }
  
    static fromSdp(sdp: string): MediaEndpoint | null {
      const ipMatch = sdp.match(/c=IN IP4 ([\d.]+)/);
      const portMatch = sdp.match(/m=audio (\d+)/);
      if (!ipMatch || !portMatch) return null;
  
      return new MediaEndpoint(ipMatch[1], parseInt(portMatch[1], 10), 'RTP', undefined, undefined, sdp);
    }
  }
  