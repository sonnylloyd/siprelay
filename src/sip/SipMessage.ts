// src/sip/SipMessage.ts
import crypto from 'crypto';
import { parse as parseSdp, write as writeSdp, MediaDescription } from 'sdp-transform';

export class SipMessage {
  public raw: string;
  public startLine: string;
  public headers: Map<string, string[]>;
  public body: string;
  private method: string;

  constructor(raw: string) {
    this.raw = raw;
    const [head, ...bodyParts] = raw.split('\r\n\r\n');
    this.body = bodyParts.join('\r\n\r\n');

    const lines = head.split('\r\n').filter(Boolean);
    this.startLine = lines.shift() || '';

    this.method = !this.isResponse() ? this.startLine.split(' ')[0].toUpperCase() : '';

    this.headers = new Map();
    for (const line of lines) {
      const [name, ...valueParts] = line.split(':');
      const key = name.trim();
      const value = valueParts.join(':').trim();

      const existing = this.headers.get(key) || [];
      existing.push(value);
      this.headers.set(key, existing);
    }
  }

  static isResponseLine(line: string): boolean {
    return line.trim().startsWith('SIP/2.0');
  }

  public isResponse(): boolean {
    return SipMessage.isResponseLine(this.startLine);
  }

  public getHeader(name: string): string[] {
    return this.headers.get(name) || [];
  }

  public getFirstHeader(name: string): string | undefined {
    return this.getHeader(name)[0];
  }

  public setHeader(name: string, value: string | string[]): void {
    this.headers.set(name, Array.isArray(value) ? value : [value]);
  }

  public addHeader(name: string, value: string): void {
    const key = name;
    const arr = this.headers.get(key) ?? [];
    arr.push(value);
    this.headers.set(key, arr);
  }

  public removeHeader(name: string): void {
    this.headers.delete(name);
  }

  public getCallId(): string | undefined {
    return this.getFirstHeader('Call-ID');
  }

  public getStatusCode(): number | undefined {
    if (!this.isResponse()) return undefined;
    const parts = this.startLine.split(' ');
    const status = parseInt(parts[1]);
    return isNaN(status) ? undefined : status;
  }

  getTargetHost(): string | null {
    const requestLine = this.startLine;
    const match = requestLine.match(/^([A-Z]+)\s+sip:([^@]+@)?([^;>\s]+)/i);
    return match ? match[3] : null;
  }

  public getTopVia(): string | undefined {
    return this.getFirstHeader('Via');
  }

  public getBranchFromVia(viaLine: string): string | undefined {
    const match = viaLine.match(/branch=([^;\s]+)/i);
    return match?.[1];
  }

  public hasRPort(viaLine: string): boolean {
    return /;rport(?:=|$)/i.test(viaLine);
  }

  public generateBranch(): string {
    return `z9hG4bK${crypto.randomBytes(6).toString('hex')}`;
  }

  public replaceViaTop(newVia: string): void {
    const vias = this.getHeader('Via');
    if (!vias.length) return;
    vias[0] = newVia;
    this.setHeader('Via', vias);
  }

  public addViaTop(newVia: string): void {
    const vias = this.getHeader('Via');
    this.setHeader('Via', [newVia, ...vias]);
  }

  public updateContact(ip: string, port: number): void {
    const contacts = this.getHeader('Contact');
    if (!contacts.length) return;

    const updated = contacts.map(value =>
      value.replace(
        /<sip:([^@>]+)@[^:>]+(?::\d+)?>/,
        `<sip:$1@${ip}:${port}>`
      )
    );
    this.setHeader('Contact', updated);
  }

  public updateSdpIp(newIp: string): void {
    if (!this.body.includes('m=')) return;

    try {
      const parsed = parseSdp(this.body);
      if (parsed.connection) parsed.connection.ip = newIp;
      (parsed.media as MediaDescription[])?.forEach(m => {
        if (m.connection) m.connection.ip = newIp;
      });
      this.body = writeSdp(parsed);
    } catch (err) {
      console.warn('SDP update failed:', err);
    }
  }

  public updateContentLength(): void {
    const len = Buffer.byteLength(this.body, 'utf8');
    this.setHeader('Content-Length', `${len}`);
  }

  public toString(): string {
    this.updateContentLength();

    const headerText = [...this.headers.entries()]
      .flatMap(([key, values]) => values.map(v => `${key}: ${v}`))
      .join('\r\n');

    return `${this.startLine}\r\n${headerText}\r\n\r\n${this.body}`;
  }

  public getMethod(): string {
    return this.method;
  }
  
  public isBye(): boolean {
    return this.method === 'BYE';
  }
  
  public isCancel(): boolean {
    return this.method === 'CANCEL';
  }
}