import { RegistrationBinding, RegistrationStore } from '../store';
import { Logger } from '../logging/Logger';
import { SipMessage } from '../sip/SipMessage';
import { PushSender } from './types';

interface DeliveryHandlers {
  ready(binding: RegistrationBinding): void;
  fail(status: number, reason: string): void;
  trying?(): void;
}

interface RequestHandlers {
  deliver(binding: RegistrationBinding): void;
  respond(status: number, reason: string): void;
}

interface CoordinatorOptions {
  waitMs?: number;
  maxEntries?: number;
}

type CallState =
  | { kind: 'waiting' | 'resuming' | 'released' }
  | { kind: 'failed'; status: number; reason: string };

interface PendingCall {
  key: string;
  domain: string;
  user: string;
  state: CallState;
  binding: RegistrationBinding;
  handlers: DeliveryHandlers;
  timer?: NodeJS.Timeout;
}

const DEFAULT_WAIT_MS = 25_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const RELEASED_CALL_TTL_MS = 180_000;
const FAILED_CALL_TTL_MS = 32_000;

/** Bounded late delivery for our app. This is not a complete RFC 8599 registrar. */
export class PushCoordinator {
  private readonly entries = new Map<string, PendingCall>();
  private readonly waitMs: number;
  private readonly maxEntries: number;
  private readonly unsubscribe: () => void;

  constructor(
    store: RegistrationStore,
    private readonly sender: PushSender,
    private readonly logger: Logger,
    options: CoordinatorOptions = {}
  ) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.unsubscribe = store.onRegistered(binding => this.handleRegistration(binding));
  }

  /** Share ACK/CANCEL/INVITE policy across transports; the caller owns network I/O. */
  handleRequest(message: SipMessage, source: string, binding: RegistrationBinding, handlers: RequestHandlers): boolean {
    if (message.getMethod() === 'ACK' && this.absorbAck(message, source)) return true;
    if (message.getMethod() === 'CANCEL' && this.cancel(message, source)) {
      handlers.respond(200, 'OK');
      return true;
    }
    return this.enqueue(message, source, binding, {
      ready: handlers.deliver,
      fail: handlers.respond,
      trying: () => handlers.respond(100, 'Trying'),
    });
  }

  /** Only intercept CANCEL while the INVITE is waiting or locally failed. */
  cancel(message: SipMessage, source: string): boolean {
    const entry = this.entries.get(this.key(message, source));
    if (!entry || entry.state.kind === 'released') return false;
    if (entry.state.kind !== 'failed') this.rejectEntry(entry, 487, 'Request Terminated');
    return true;
  }

  absorbAck(message: SipMessage, source: string): boolean {
    return this.entries.get(this.key(message, source))?.state.kind === 'failed';
  }

  enqueue(message: SipMessage, source: string, binding: RegistrationBinding, handlers: DeliveryHandlers): boolean {
    if (message.getMethod() !== 'INVITE' || message.isInDialog()) return false;
    const key = this.key(message, source);
    const existing = this.entries.get(key);
    if (existing) {
      this.replay(existing, handlers);
      return true;
    }
    if (!binding.push || !this.sender.supports(binding.push)) return false;
    if (this.entries.size >= this.maxEntries) {
      handlers.fail(503, 'Service Unavailable');
      return true;
    }

    const entry: PendingCall = {
      key,
      domain: binding.domain,
      user: binding.user,
      binding,
      handlers,
      state: { kind: 'waiting' },
    };
    this.entries.set(key, entry);
    this.schedule(entry, this.waitMs, () => this.rejectEntry(entry, 480, 'Temporarily Unavailable'));
    handlers.trying?.();
    void this.sender.send(binding.push, message.getCallId() ?? '').catch(() => {
      if (this.entries.get(entry.key) !== entry) return;
      // No device token, push payload or credentials in logs.
      this.logger.warn('Mobile push delivery failed');
      if (entry.state.kind === 'waiting' || entry.state.kind === 'resuming') {
        this.rejectEntry(entry, 503, 'Service Unavailable');
      }
    });
    return true;
  }

  dispose(): void {
    this.unsubscribe();
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private handleRegistration(binding: RegistrationBinding): void {
    for (const entry of this.entries.values()) {
      const matchesAccount = entry.domain.toLowerCase() === binding.domain.toLowerCase() && entry.user === binding.user;
      const previousPush = entry.binding.push;
      const currentPush = binding.push;
      // An account may have several devices. A different device registering must not
      // release a call that was addressed to this device's push destination.
      const matchesDevice = previousPush && currentPush
        && previousPush.provider === currentPush.provider
        && previousPush.app === currentPush.app && previousPush.token === currentPush.token;
      if (entry.state.kind !== 'waiting' || !matchesAccount || !matchesDevice) continue;
      if (entry.binding.transport !== binding.transport) {
        this.rejectEntry(entry, 480, 'Temporarily Unavailable');
        continue;
      }
      this.resume(entry, binding);
    }
  }

  private resume(entry: PendingCall, binding: RegistrationBinding): void {
    entry.state = { kind: 'resuming' };
    entry.binding = binding;
    this.scheduleEviction(entry, RELEASED_CALL_TTL_MS);
    // Send the REGISTER 200 first; a CANCEL may still arrive before this microtask.
    queueMicrotask(() => {
      if (entry.state.kind !== 'resuming' || this.entries.get(entry.key) !== entry) return;
      entry.state = { kind: 'released' };
      entry.handlers.ready(binding);
    });
  }

  private replay(entry: PendingCall, handlers: DeliveryHandlers): void {
    switch (entry.state.kind) {
      case 'waiting':
      case 'resuming':
        handlers.trying?.();
        break;
      case 'released':
        handlers.ready(entry.binding);
        break;
      case 'failed':
        handlers.fail(entry.state.status, entry.state.reason);
        break;
    }
  }

  private rejectEntry(entry: PendingCall, status: number, reason: string): void {
    entry.state = { kind: 'failed', status, reason };
    this.scheduleEviction(entry, FAILED_CALL_TTL_MS);
    entry.handlers.fail(status, reason);
  }

  private scheduleEviction(entry: PendingCall, delayMs: number): void {
    this.schedule(entry, delayMs, () => this.entries.delete(entry.key));
  }

  private schedule(entry: PendingCall, delayMs: number, action: () => void): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.entries.get(entry.key) === entry) action();
    }, delayMs);
    entry.timer.unref();
  }

  private key(message: SipMessage, source: string): string {
    return JSON.stringify([
      source,
      message.getCallId(),
      message.getCSeqNumber(),
      message.getBranchFromVia(message.getTopVia() ?? ''),
    ]);
  }
}
