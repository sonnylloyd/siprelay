import { splitSipList } from './SipList';
import crypto from 'crypto';
import { formatSipHost, parseSipUri, readAddressTag, splitNameAddress, SipAddress } from './SipUri';
import { formatHeaderName, normalizeHeaderName } from './SipHeaderNames';

export class SipMessage {
  public startLine: string;
  public headers: Map<string, string[]>;
  private bodyBytes = Buffer.alloc(0);

  public get body(): string { return this.bodyBytes.toString(); }
  public set body(value: string) { this.bodyBytes = Buffer.from(value); }
  private malformedHeaders = false;
  private secureRouting = false;

  constructor(raw: string | Buffer, options: { datagram?: boolean } = {}) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const boundary = bytes.indexOf('\r\n\r\n');
    const head = (boundary < 0 ? bytes : bytes.subarray(0, boundary)).toString();
    this.bodyBytes = boundary < 0 ? Buffer.alloc(0) : Buffer.from(bytes.subarray(boundary + 4));

    const lines = head.split('\r\n').filter(Boolean);
    this.startLine = (lines.shift() || '').replace(/^sip\/2\.0/i, 'SIP/2.0').replace(/ sip\/2\.0$/i, ' SIP/2.0');

    this.headers = new Map();
    this.parseHeaders(lines);
    // RFC 3261 section 18.3: bytes beyond Content-Length in a datagram are discarded.
    const lengths = this.getHeader('Content-Length');
    if (options.datagram && lengths.length === 1 && /^\d+$/.test(lengths[0])) {
      const length = Number(lengths[0]);
      if (length < this.bodyBytes.length) this.bodyBytes = this.bodyBytes.subarray(0, length);
    }
  }

  private parseHeaders(lines: string[]): void {
    let previousKey: string | undefined;
    for (const line of lines) {
      if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) { this.malformedHeaders = true; continue; }
      if (/^[ \t]/.test(line) && previousKey) {
        const values = this.headers.get(previousKey)!;
        values[values.length - 1] += ` ${line.trim()}`;
        continue;
      }
      if (!line.includes(':')) {
        this.malformedHeaders = true;
        continue;
      }
      const [name, ...valueParts] = line.split(':');
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name.trim())) {
        this.malformedHeaders = true;
        continue;
      }
      const key = normalizeHeaderName(name.trim());
      const value = valueParts.join(':').trim();

      const existing = this.headers.get(key) || [];
      existing.push(value);
      this.headers.set(key, existing);
      previousKey = key;
    }
  }

  public isValid(): boolean {
    const validStartLine = /^(?:[A-Za-z0-9.!%*_+`'~-]+ \S+ SIP\/2\.0|SIP\/2\.0 [1-6]\d{2} .*)$/.test(this.startLine);
    return !this.malformedHeaders && validStartLine && this.hasRequiredHeaders()
      && this.hasValidCSeq() && this.hasValidContentLength();
  }

  private hasRequiredHeaders(): boolean {
    for (const name of ['Call-ID', 'From', 'To', 'CSeq']) {
      if (this.getHeader(name).length !== 1 || !this.getFirstHeader(name)) return false;
    }
    for (const name of ['From', 'To']) {
      const value = this.getFirstHeader(name)!;
      if (!parseSipUri(value) || readAddressTag(value) === null) return false;
    }
    const via = this.getTopVia();
    return Boolean(via && this.getBranchFromVia(via));
  }

  private hasValidCSeq(): boolean {
    const cseq = this.getFirstHeader('CSeq')?.match(/^(\d+)\s+([A-Za-z0-9.!%*_+`'~-]+)$/);
    if (!cseq || Number(cseq[1]) > 2_147_483_647) return false;
    return this.isResponse() || cseq[2] === this.getMethod();
  }

  private hasValidContentLength(): boolean {
    const lengths = this.getHeader('Content-Length');
    // Content-Length is optional for UDP; the stream decoder requires it for TLS.
    if (!lengths.length) return true;
    return lengths.length === 1 && /^\d+$/.test(lengths[0])
      && Number(lengths[0]) === this.bodyBytes.length;
  }

  static isResponseLine(line: string): boolean {
    return line.trim().startsWith('SIP/2.0');
  }

  public isResponse(): boolean {
    return SipMessage.isResponseLine(this.startLine);
  }

  public getMethod(): string | undefined {
    if (this.isResponse()) return undefined;
    const [method] = this.startLine.split(' ');
    return method;
  }

  public getHeader(name: string): string[] {
    return this.headers.get(normalizeHeaderName(name)) || [];
  }

  public getFirstHeader(name: string): string | undefined {
    return this.getHeader(name)[0];
  }

  public setHeader(name: string, value: string | string[]): void {
    this.headers.set(normalizeHeaderName(name), Array.isArray(value) ? value : [value]);
  }

  public addHeader(name: string, value: string): void {
    this.setHeader(name, [...this.getHeader(name), value]);
  }

  public removeHeader(name: string): void {
    this.headers.delete(normalizeHeaderName(name));
  }

  /** SIPS applies to the request target and next Route, not merely the connection type. */
  public requiresSecureTransport(): boolean {
    const target = this.isResponse() ? '' : this.startLine.split(/\s+/)[1];
    const route = splitNameAddress(this.getFirstHeader('Route')?.split(',')[0] ?? '')?.uri;
    return this.secureRouting || /^sips:/i.test(target ?? '') || /^sips:/i.test(route ?? '');
  }

  public getRouteFlowToken(): string | undefined {
    const user = parseSipUri(this.getFirstHeader('Route')?.split(',')[0] ?? '')?.user;
    return user?.startsWith('ft.') ? user : undefined;
  }

  public addRegistrationPath(token: string, domain: string, host: string, port: number, transport: 'UDP' | 'TCP' | 'TLS'): void {
    const scheme = this.requiresSecureTransport() ? 'sips' : 'sip';
    const path = `<${scheme}:${token}@${formatSipHost(host)}:${port};transport=${transport.toLowerCase()};lr;sr-domain=${encodeURIComponent(domain)}>`;
    this.setHeader('Path', [path, ...this.getHeader('Path')]);
    if (!this.getHeader('Require').some(value => value.split(',').some(tag => tag.trim().toLowerCase() === 'path'))) this.addHeader('Require', 'path');
  }

  public hasSafeRegistration(mode: 'path' | 'contact' = 'contact'): boolean {
    if (this.getMethod() !== 'REGISTER') return true;
    const account = this.getAddressOfRecord();
    if (!account?.user || account.host !== this.getTargetHost()) return false;
    const contacts = this.getContactHeaders();
    if (!contacts.length) return true; // A registrar query does not install a binding.
    if (contacts.length !== 1 && mode === 'contact') return false;
    if (contacts.length === 1 && contacts[0].trim() === '*') return this.getFirstHeader('Expires')?.trim() === '0';
    if (mode === 'path') return contacts.every(contact => Boolean(parseSipUri(contact)?.user));
    return parseSipUri(contacts[0])?.user === account.user;
  }

  public useClientContact(contact?: string): void {
    if (!contact || this.isResponse()) return;
    const uri = splitNameAddress(contact)?.uri;
    if (!uri) return;
    if (!/^sips?:[^\s<>]+$/i.test(uri)) return;
    const target = uri.replace(/;pn-[^=;?]+=[^;?]*/ig, '');
    this.startLine = `${this.getMethod()} ${target} SIP/2.0`;
  }

  public addRecordRoute(domain: string, host: string, port: number, transport: 'UDP' | 'TCP' | 'TLS', flowToken?: string): void {
    if (!['INVITE', 'SUBSCRIBE'].includes(this.getMethod() ?? '') || this.isInDialog()) return;
    const address = formatSipHost(host);
    const scheme = this.requiresSecureTransport() ? 'sips' : 'sip';
    const uri = `<${scheme}:${flowToken ? `${flowToken}@` : ''}${address}:${port};transport=${transport.toLowerCase()};lr;sr-domain=${encodeURIComponent(domain)}>`;
    this.setHeader('Record-Route', [uri, ...this.getHeader('Record-Route')]);
  }

  /** Consume our loose Route and return its Docker tenant domain. */
  public hasUnsafeRouting(proxyHost: string, allowRecordRoute = false): boolean {
    if (!allowRecordRoute && this.getHeader('Record-Route').length) return true;
    const routes = this.getRouteValues();
    if (!routes.length) return false;
    const uri = splitNameAddress(routes[0])?.uri ?? '';
    // A registrar may retain Path as well as the dialog Record-Route, producing
    // repeated routes to this same flow. Never admit a different second hop/token.
    if (routes.some(route => splitNameAddress(route)?.uri !== uri)) return true;
    const address = parseSipUri(uri);
    return address?.host !== proxyHost.toLowerCase() || uri.includes('?') || !/;lr(?:;|$)/i.test(uri);
  }

  public takeProxyRoute(proxyHost: string): string | undefined {
    const routes = this.getRouteValues();
    if (!routes.length) return;
    const first = routes[0];
    const uri = splitNameAddress(first)?.uri ?? '';
    if (parseSipUri(uri)?.host !== proxyHost.toLowerCase() || !/;lr(?:;|$)/i.test(uri)) return;
    const domain = uri.match(/;sr-domain=([^;\s]+)/i)?.[1];
    if (!domain) return;
    let decoded: string;
    try { decoded = decodeURIComponent(domain).toLowerCase(); } catch { return; }
    this.secureRouting ||= /^sips:/i.test(uri);
    while (routes.length && splitNameAddress(routes[0])?.uri === uri) routes.shift();
    if (routes.length) this.setHeader('Route', routes); else this.removeHeader('Route');
    return decoded;
  }

  private getRouteValues(): string[] {
    return this.getHeader('Route').flatMap(value => splitSipList(value) ?? [value]);
  }

  public decrementMaxForwards(): boolean {
    const values = this.getHeader('Max-Forwards');
    if (!values.length) {
      this.setHeader('Max-Forwards', '70');
      return true;
    }
    if (values.length !== 1 || !/^\d+$/.test(values[0])) return false;
    const hops = Number(values[0]);
    if (!Number.isSafeInteger(hops) || hops <= 0 || hops > 255) return false;
    this.setHeader('Max-Forwards', String(hops - 1));
    return true;
  }

  public createResponse(status: number, reason: string, headers: Readonly<Record<string, string>> = {}): string {
    const response = new SipMessage(`SIP/2.0 ${status} ${reason}\r\n\r\n`);
    for (const name of ['Via', 'From', 'To', 'Call-ID', 'CSeq']) {
      response.setHeader(name, this.getHeader(name));
    }
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    const to = response.getFirstHeader('To');
    if (status > 100 && to && !this.isInDialog()) {
      const identity = [this.getCallId(), this.getBranchFromVia(this.getTopVia() ?? '')];
      const tag = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
      response.setHeader('To', `${to};tag=${tag}`);
    }
    return response.toString();
  }

  /** RFC 3581 rport overrides the sent-by port; otherwise RFC 3261 Via routing applies. */
  public getUdpResponsePort(sourcePort: number): number {
    const via = this.getTopVia() ?? '';
    if (this.hasRPort(via.split(',')[0])) return sourcePort;
    const port = via.match(/^SIP\/2\.0\/UDP\s+(?:\[[^\]]+\]|[^:;,\s]+)(?::(\d+))?/i)?.[1];
    const number = Number(port ?? 5060);
    return number > 0 && number <= 65535 ? number : 5060;
  }

  public setReceived(address: string, port: number): void {
    const via = this.getTopVia();
    if (!via) return;
    const comma = via.indexOf(',');
    let first = comma < 0 ? via : via.slice(0, comma);
    first = first.replace(/;received=[^;,\s]+/ig, '');
    if (this.hasRPort(first)) first = first.replace(/;rport(?:=[^;,\s]*)?(?=;|$)/i, `;rport=${port}`);
    this.replaceViaTop(`${first};received=${address}${comma < 0 ? '' : via.slice(comma)}`);
  }

  public getTransactionKey(branch = this.getBranchFromVia(this.getTopVia() ?? '')): string {
    const method = this.getCSeqMethod();
    const cseq = method ? `${this.getCSeqNumber()} ${method}` : undefined;
    return JSON.stringify([this.getCallId(), cseq, branch]);
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

  public getCSeqNumber(): string | undefined {
    const number = this.getFirstHeader('CSeq')?.trim().split(/\s+/)[0];
    return number === undefined ? undefined : String(Number(number));
  }

  public getFromTag(): string | undefined {
    return readAddressTag(this.getFirstHeader('From') ?? '') ?? undefined;
  }

  public getToTag(): string | undefined {
    return readAddressTag(this.getFirstHeader('To') ?? '') ?? undefined;
  }

  public isInDialog(): boolean {
    return this.getToTag() !== undefined;
  }

  public getCSeqMethod(): string | undefined {
    const cseq = this.getFirstHeader('CSeq');
    if (!cseq) return undefined;
    const parts = cseq.trim().split(/\s+/);
    return parts[1];
  }

  public getTargetHost(): string | null {
    if (this.isResponse()) return null;
    return parseSipUri(this.startLine.split(/\s+/)[1] ?? '')?.host ?? null;
  }

  public getTargetUser(): string | null {
    if (this.isResponse()) return null;
    return parseSipUri(this.startLine.split(/\s+/)[1] ?? '')?.user ?? null;
  }

  public getAddressOfRecord(): SipAddress | null {
    const toHeader = this.getFirstHeader('To');
    if (!toHeader) return null;
    return parseSipUri(toHeader);
  }

  public getContactHeaders(): string[] {
    return this.getHeader('Contact').flatMap(value => splitSipList(value) ?? [value]);
  }

  public getTopVia(): string | undefined {
    return this.getFirstHeader('Via');
  }

  public getBranchFromVia(viaLine: string): string | undefined {
    const top = viaLine.split(',')[0];
    const branches = [...top.matchAll(/;branch=([^;,\s]+)/ig)];
    return branches.length === 1 ? branches[0][1] : undefined;
  }

  public hasRPort(viaLine: string): boolean {
    return /;rport(?:=|;|,|$)/i.test(viaLine);
  }

  public generateBranch(): string {
    // Retransmissions, CANCEL and non-2xx ACK reuse the INVITE's proxy branch.
    const identity = [this.getCallId(), this.getCSeqNumber(), this.getTopVia()];
    return `z9hG4bK${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
  }

  public replaceViaTop(newVia: string): void {
    const vias = this.getHeader('Via');
    if (!vias.length) return;
    vias[0] = newVia;
    this.setHeader('Via', vias);
  }

  public removeViaTop(): void {
    const vias = [...this.getHeader('Via')];
    if (!vias.length) return;
    // A Via list may use separate fields or a comma-separated value.
    const comma = vias[0].indexOf(',');
    if (comma >= 0) vias[0] = vias[0].slice(comma + 1).trim();
    else vias.shift();
    if (vias.length) this.setHeader('Via', vias);
    else this.removeHeader('Via');
  }

  public addViaTop(newVia: string): void {
    const vias = this.getHeader('Via');
    this.setHeader('Via', [newVia, ...vias]);
  }

  public updateContact(ip: string, port: number): void {
    const contacts = this.getHeader('Contact');
    if (!contacts.length) return;

    const updated = contacts.map(value => {
      const address = splitNameAddress(value);
      if (!address || !parseSipUri(value)) return value;
      const rewritten = address.uri.replace(
        /^(sips?:)([^@<>\s]+)@(\[[^\]]+\]|[^:;?>\s]+)(?::\d+)?/i,
        (_match, scheme, user) => `${scheme}${user}@${formatSipHost(ip)}:${port}`
      );
      const start = value.includes('<') ? value.lastIndexOf('<') + 1 : value.indexOf(address.uri);
      return value.slice(0, start) + rewritten + value.slice(start + address.uri.length);
    });
    this.setHeader('Contact', updated);
  }

  public updateContentLength(): void {
    const len = this.bodyBytes.length;
    this.setHeader('Content-Length', `${len}`);
  }

  /** Preserve octets and secure routing intent when deferring or replaying a request. */
  public clone(): SipMessage {
    const copy = new SipMessage(this.toBuffer());
    copy.secureRouting = this.secureRouting;
    return copy;
  }

  public toString(): string { return this.toBuffer().toString(); }

  public toBuffer(): Buffer {
    this.updateContentLength();

    const headerText = [...this.headers.entries()]
      .flatMap(([key, values]) => values.map(value => `${formatHeaderName(key)}: ${value}`))
      .join('\r\n');

    return Buffer.concat([Buffer.from(`${this.startLine}\r\n${headerText}\r\n\r\n`), this.bodyBytes]);
  }
}
