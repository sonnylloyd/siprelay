import { splitNameAddress } from './SipUri';
import type { Socket } from 'net';
import type { SipTransport } from '../constants/transport';
import { parsePushDestination } from '../push/PushDestination';
import { RegistrationStore } from '../store';
import { Logger } from '../logging/Logger';
import { SipMessage } from './SipMessage';

interface RegistrationClient {
  address: string;
  port: number;
  transport?: SipTransport;
  socket?: Socket;
  flowToken?: string;
}

interface PendingRegistration {
  domain: string;
  user: string;
  client: RegistrationClient;
  contact?: string;
  contacts: string[];
  requestedExpiry: number | null;
  timeout: NodeJS.Timeout;
}

export class RegistrationService {
  private readonly pending = new Map<string, PendingRegistration>();

  constructor(
    private readonly store: RegistrationStore,
    private readonly logger: Logger,
    private readonly ttlMs = 30_000,
    private readonly mode: 'contact' | 'path' = 'contact'
  ) {}

  public trackRequest(
    sipMsg: SipMessage,
    client: RegistrationClient,
    proxyBranch = sipMsg.generateBranch()
  ): void {
    const aor = sipMsg.getAddressOfRecord();
    if (sipMsg.getMethod() !== 'REGISTER' || !sipMsg.getCallId() || !aor?.user || !sipMsg.hasSafeRegistration(this.mode)) return;
    const key = sipMsg.getTransactionKey(proxyBranch);
    const { host: domain, user } = aor;

    // A REGISTER without Contact only queries the registrar; it creates no binding.
    if (!sipMsg.getContactHeaders().length) return;
    if (!this.pending.has(key) && this.pending.size >= 10_000) return;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => this.pending.delete(key), this.ttlMs);
    timeout.unref();

    this.pending.set(key, {
      domain,
      user,
      client: { ...client, transport: client.transport ?? 'UDP' },
      contact: sipMsg.getContactHeaders()[0],
      contacts: sipMsg.getContactHeaders(),
      requestedExpiry: this.getRegistrationExpiry(sipMsg),
      timeout,
    });
  }

  public handleResponse(sipMsg: SipMessage): void {
    if (!sipMsg.getCallId()) return;
    const key = sipMsg.getTransactionKey();

    const pending = this.pending.get(key);
    if (!pending) return;

    const status = sipMsg.getStatusCode();
    if (status && status < 200 && sipMsg.getCSeqMethod() === 'REGISTER') return;

    try {
      if (sipMsg.getCSeqMethod() !== 'REGISTER' || !status || status >= 300) return;
      if (this.mode === 'path' && pending.contact !== '*') { this.applyPathBindings(pending, sipMsg); return; }
      const expires = this.getRegistrationExpiry(sipMsg) ?? pending.requestedExpiry;
      if (expires === null) return;
      if (expires === 0) {
        if (this.store.remove(pending.domain, pending.user, this.mode === 'path' && pending.contact !== '*' ? splitNameAddress(pending.contact!)?.uri : undefined)) {
          this.logger.info(`Removed registration for ${pending.user}@${pending.domain}`);
        }
        return;
      }
      this.storeRegistration(pending, sipMsg, expires);
    } finally {
      this.removePending(key);
    }
  }

  private storeRegistration(pending: PendingRegistration, response: SipMessage, expires: number, acceptedContact?: string): void {
    this.store.upsert({
      ...(this.mode === 'path' ? { id: splitNameAddress(pending.contact!)?.uri, flowToken: pending.client.flowToken } : {}),
      domain: pending.domain,
      user: pending.user,
      clientAddress: pending.client.address,
      clientPort: pending.client.port,
      contact: acceptedContact ?? response.getContactHeaders()[0] ?? pending.contact,
      clientContact: pending.contact,
      transport: pending.client.transport,
      socket: pending.client.socket,
      push: parsePushDestination(pending.contact),
      expiresAt: Date.now() + expires * 1_000,
    });
    this.logger.info(
      `Stored registration for ${pending.user}@${pending.domain} via ${pending.client.address}:${pending.client.port} (expires in ${expires}s)`
    );
  }

  private applyPathBindings(pending: PendingRegistration, response: SipMessage): void {
    for (const contact of pending.contacts) {
      const uri = splitNameAddress(contact)!.uri;
      const accepted = response.getContactHeaders().find(value => splitNameAddress(value)?.uri === uri);
      const parameters = accepted ? splitNameAddress(accepted)?.parameters : undefined;
      const declared = parameters?.match(/(?:^|;)\s*expires\s*=\s*(\d+)\s*(?:;|$)/i)?.[1];
      const expires = declared !== undefined ? Number(declared) : this.extractExpiresHeader(response);
      if (expires === 0 || (!accepted && /;\s*expires\s*=\s*0\s*(?:;|$)/i.test(contact))) {
        this.store.remove(pending.domain, pending.user, uri); continue;
      }
      if (!accepted || expires === null || !Number.isSafeInteger(expires) || expires < 0 || expires > 0xffff_ffff) continue;
      this.storeRegistration({ ...pending, contact }, response, expires, accepted);
    }
  }

  private removePending(key: string): void {
    const registration = this.pending.get(key);
    if (registration) clearTimeout(registration.timeout);
    this.pending.delete(key);
  }

  private getRegistrationExpiry(sipMsg: SipMessage): number | null {
    const contactHeaders = sipMsg.getContactHeaders();
    for (const header of contactHeaders) {
      if (header.trim() === '*') {
        const expiresHeader = this.extractExpiresHeader(sipMsg);
        return expiresHeader ?? 0;
      }
      const match = header.match(/;expires=([^;\s]+)/i);
      if (match) {
        if (!/^\d+$/.test(match[1])) return null;
        const value = Number(match[1]);
        return Number.isSafeInteger(value) ? value : null;
      }
    }

    return this.extractExpiresHeader(sipMsg);
  }

  private extractExpiresHeader(sipMsg: SipMessage): number | null {
    const expiresHeader = sipMsg.getFirstHeader('Expires');
    if (!expiresHeader) return null;
    if (!/^\d+$/.test(expiresHeader.trim())) return null;
    const value = Number(expiresHeader);
    return Number.isSafeInteger(value) ? value : null;
  }
}
