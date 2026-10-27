import { SipMessage } from '../sip/SipMessage';

export interface DialogContext {
  domain: string;
  clientFlow: string;
  requestMethod?: string;
  fromTag?: string;
  toTag?: string;
  inviteKey?: string;
}

interface Dialog {
  clientFlow: string;
  ackOnly: boolean;
  expires: number;
}

/** The PBX authenticates initial requests. This guard pins subsequent controls to the observed phone flow. */
export class DialogGuard {
  private readonly dialogs = new Map<string, Dialog>();
  private readonly invites = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {}

  context(message: SipMessage, domain: string, clientFlow: string): DialogContext {
    return { domain, clientFlow, requestMethod: message.getMethod(), fromTag: message.getFromTag(), toTag: message.getToTag(),
      inviteKey: message.getMethod() === 'INVITE' ? this.inviteKey(message, domain, clientFlow) : undefined };
  }

  authorize(message: SipMessage, domain: string, clientFlow: string): boolean {
    this.purge();
    const method = message.getMethod();
    if (method === 'CANCEL') return this.invites.has(this.inviteKey(message, domain, clientFlow));
    if (message.isInDialog()) {
      const key = this.dialogKey(message, domain);
      const dialog = key ? this.dialogs.get(key) : undefined;
      if (!dialog || dialog.clientFlow !== clientFlow || (dialog.ackOnly && method !== 'ACK')) return false;
      dialog.expires = Date.now() + (dialog.ackOnly ? 32_000 : 24 * 60 * 60 * 1000);
      return true;
    }
    if (['ACK', 'BYE', 'UPDATE', 'INFO', 'REFER', 'NOTIFY', 'PRACK'].includes(method ?? '')) return false;
    return true;
  }

  trackInvite(message: SipMessage, domain: string, clientFlow: string): boolean {
    this.purge();
    if (message.getMethod() !== 'INVITE') return true;
    const key = this.inviteKey(message, domain, clientFlow);
    if (!this.invites.has(key) && this.invites.size >= this.maxEntries) return false;
    this.invites.set(key, Date.now() + 180_000);
    return true;
  }

  observeResponse(message: SipMessage, context?: DialogContext): void {
    if (!context || !['INVITE', 'SUBSCRIBE'].includes(context.requestMethod ?? '')) return;
    if (message.getFromTag() !== context.fromTag || (context.toTag && message.getToTag() !== context.toTag)) return;
    const status = message.getStatusCode() ?? 0;
    if (status >= 200 && context.inviteKey) this.invites.delete(context.inviteKey);
    if (status <= 100) return;
    const key = this.dialogKey(message, context.domain);
    if (!key) return;
    this.purge();
    if (!this.dialogs.has(key) && this.dialogs.size >= this.maxEntries) return;
    const previous = this.dialogs.get(key);
    // A response cannot move an existing dialog to another network flow.
    if (previous && (previous.clientFlow !== context.clientFlow || (context.toTag && status >= 300))) return;
    this.dialogs.set(key, { clientFlow: context.clientFlow, ackOnly: status >= 300,
      expires: Date.now() + (status >= 300 ? 32_000 : status < 200 ? 180_000 : 24 * 60 * 60 * 1000) });
  }

  private dialogKey(message: SipMessage, domain: string): string | undefined {
    const from = message.getFromTag(), to = message.getToTag();
    if (!from || !to) return;
    return JSON.stringify([domain.toLowerCase(), message.getCallId(), ...[from, to].sort()]);
  }

  private inviteKey(message: SipMessage, domain: string, flow: string): string {
    return JSON.stringify([domain.toLowerCase(), flow, message.getCallId(), message.getCSeqNumber(),
      message.getBranchFromVia(message.getTopVia() ?? ''), message.getFromTag()]);
  }

  private purge(): void {
    const now = Date.now();
    for (const [key, dialog] of this.dialogs) if (dialog.expires <= now) this.dialogs.delete(key);
    for (const [key, expires] of this.invites) if (expires <= now) this.invites.delete(key);
  }
}
