import { RegistrationStore } from '../store';
import { Logger } from '../logging/Logger';
import { SipMessage } from './SipMessage';

type PendingRegistration = {
  domain: string;
  user: string;
  clientAddress: string;
  clientPort: number;
  contact?: string;
  timeout: NodeJS.Timeout;
};

export class RegistrationService {
  private pending: Map<string, PendingRegistration>;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private readonly store: RegistrationStore;

  constructor(store: RegistrationStore, logger: Logger, ttlMs = 30000) {
    this.pending = new Map();
    this.store = store;
    this.logger = logger;
    this.ttlMs = ttlMs;
  }

  public trackRequest(
    callId: string | undefined,
    sipMsg: SipMessage,
    client: { address: string; port: number }
  ): void {
    if (!callId) return;

    const aor = sipMsg.getAddressOfRecord();
    const domain = aor?.host ?? sipMsg.getTargetHost();
    const user = aor?.user ?? sipMsg.getTargetUser();

    if (!domain || !user) {
      this.logger.warn('Unable to extract AoR from REGISTER request');
      return;
    }

    const existing = this.pending.get(callId);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => this.pending.delete(callId), this.ttlMs);

    this.pending.set(callId, {
      domain,
      user,
      clientAddress: client.address,
      clientPort: client.port,
      contact: sipMsg.getContactHeaders()[0],
      timeout,
    });
  }

  public handleResponse(callId: string | undefined, sipMsg: SipMessage): void {
    if (!callId) return;

    const pending = this.pending.get(callId);
    if (!pending) return;

    const clearPending = () => {
      clearTimeout(pending.timeout);
      this.pending.delete(callId);
    };

    const status = sipMsg.getStatusCode();
    const cseqMethod = sipMsg.getCSeqMethod()?.toUpperCase();
    if (cseqMethod !== 'REGISTER') {
      clearPending();
      return;
    }

    if (!status || status < 200 || status >= 300) {
      clearPending();
      return;
    }

    const expires = this.getRegistrationExpiry(sipMsg);
    if (expires === null) {
      clearPending();
      return;
    }

    if (expires === 0) {
      const removed = this.store.remove(pending.domain, pending.user);
      if (removed) {
        this.logger.info(`Removed registration for ${pending.user}@${pending.domain}`);
      }
      clearPending();
      return;
    }

    const contact = sipMsg.getContactHeaders()[0] ?? pending.contact;
    this.store.upsert({
      domain: pending.domain,
      user: pending.user,
      clientAddress: pending.clientAddress,
      clientPort: pending.clientPort,
      contact,
      expiresAt: Date.now() + expires * 1000,
    });

    clearPending();

    this.logger.info(
      `Stored registration for ${pending.user}@${pending.domain} via ${pending.clientAddress}:${pending.clientPort} (expires in ${expires}s)`
    );
  }

  public purgeExpiredPending(): void {
    for (const [callId, pending] of this.pending.entries()) {
      if (!pending.timeout) continue;
      // timeout callback cleans itself, so nothing needed here yet; placeholder for future logic
      if (!this.pending.has(callId)) continue;
    }
  }

  private getRegistrationExpiry(sipMsg: SipMessage): number | null {
    const contactHeaders = sipMsg.getContactHeaders();
    for (const header of contactHeaders) {
      if (header.includes('*')) {
        const expiresHeader = this.extractExpiresHeader(sipMsg);
        return expiresHeader ?? 0;
      }
      const match = header.match(/;expires=(\d+)/i);
      if (match) {
        const value = Number.parseInt(match[1], 10);
        if (!Number.isNaN(value)) return value;
      }
    }

    const globalExpires = this.extractExpiresHeader(sipMsg);
    if (globalExpires !== null) return globalExpires;
    return 3600;
  }

  private extractExpiresHeader(sipMsg: SipMessage): number | null {
    const expiresHeader = sipMsg.getFirstHeader('Expires');
    if (!expiresHeader) return null;
    const value = Number.parseInt(expiresHeader, 10);
    return Number.isNaN(value) ? null : value;
  }
}
