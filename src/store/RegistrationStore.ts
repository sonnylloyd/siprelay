import { FlowTokenCodec, FlowIdentity } from '../security/FlowTokenCodec';
import type { Socket } from 'net';
import type { SipTransport } from '../constants/transport';
import type { PushDestination } from '../push/types';
import type { Logger } from '../logging/Logger';
import { PushStorage, deviceKey, saveDevice } from './persistence/PushStorage';
import { DeviceWriter } from './persistence/DeviceWriter';

export interface RegistrationBinding {
  /** Restored registrations have no usable network connection until refreshed. */
  dormant?: boolean;
  domain: string;
  user: string;
  clientAddress: string;
  clientPort: number;
  contact?: string;
  clientContact?: string;
  transport?: SipTransport;
  socket?: Socket;
  push?: PushDestination;
  expiresAt: number;
  id?: string;
  flowToken?: string;
}

export class RegistrationStore {
  private initialization?: Promise<void>;
  private initialized: boolean;
  private readonly writer?: DeviceWriter;

  constructor(private readonly storage?: PushStorage, logger?: Logger) {
    this.initialized = !storage;
    if (storage) this.writer = new DeviceWriter(storage, logger);
  }

  public get storageHealthy(): boolean { return this.initialized && (this.writer?.healthy ?? true); }
  public initialize(): Promise<void> {
    return this.initialization ??= this.restore();
  }

  private async restore(): Promise<void> {
    if (!this.storage) return;
    try {
      const { secret, devices } = await this.storage.open();
      this.flowTokens = new FlowTokenCodec(secret);
      for (const device of devices) {
        if (device.flowToken) {
          const identity = this.readFlowToken(device.flowToken);
          if (!identity || identity.domain !== device.domain.toLowerCase() || identity.user !== device.user) throw new Error('Invalid stored route identity');
        }
        if (device.expiresAt > Date.now()) this.put({ ...device, dormant: true, clientAddress: '', clientPort: 0 });
      }
      this.initialized = true;
    } catch {
      await this.storage.close();
      throw new Error('Unable to initialize push storage');
    }
  }

  public async flush(): Promise<void> { await this.writer?.flush(); }
  public async close(): Promise<void> { await this.writer?.close(); }

  private persist(binding: RegistrationBinding, removed = false): void {
    if (removed && !binding.push) return;
    this.writer?.change({ key: deviceKey(binding), device: removed ? undefined : saveDevice(binding) });
  }

  private readonly listeners = new Set<(binding: RegistrationBinding) => void>();

  public onRegistered(listener: (binding: RegistrationBinding) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readonly bindings = new Map<string, Map<string, RegistrationBinding>>();
  private flowTokens = new FlowTokenCodec();

  private buildKey(domain: string, user: string): string {
    return JSON.stringify([domain.toLowerCase(), user]);
  }

  public createFlowToken(identity: FlowIdentity): string { return this.flowTokens.encode(identity); }
  public readFlowToken(token: string): FlowIdentity | undefined { return this.flowTokens.decode(token); }

  public getByFlowToken(token: string): RegistrationBinding | undefined {
    const identity = this.readFlowToken(token);
    if (!identity) return;
    return this.getAll(identity.domain, identity.user).find(binding => binding.flowToken && this.readFlowToken(binding.flowToken)?.flow === identity.flow);
  }

  public getFlowToken(domain: string, flow: string): string | undefined {
    for (const account of this.bindings.values()) for (const binding of account.values()) {
      if (binding.expiresAt <= Date.now() || !binding.flowToken) continue;
      const identity = this.readFlowToken(binding.flowToken);
      if (identity?.domain === domain.toLowerCase() && identity.flow === flow) return binding.flowToken;
    }
    return;
  }

  public upsert(binding: RegistrationBinding): void {
    if (!this.initialized) throw new Error('Push storage is not initialized');
    const previous = this.bindings.get(this.buildKey(binding.domain, binding.user))?.get(binding.id ?? 'legacy');
    this.put(binding);
    if (binding.push || previous?.push) this.persist(binding);
    for (const listener of this.listeners) listener(binding);
  }

  private put(binding: RegistrationBinding): void {
    const key = this.buildKey(binding.domain, binding.user);
    let account = this.bindings.get(key);
    if (!account) { account = new Map(); this.bindings.set(key, account); }
    const id = binding.id ?? 'legacy';
    account.delete(id); account.set(id, binding);
  }

  public remove(domain: string, user: string, id?: string): boolean {
    const key = this.buildKey(domain, user);
    const account = this.bindings.get(key);
    if (id === undefined) {
      if (account) for (const binding of account.values()) this.persist(binding, true);
      return this.bindings.delete(key);
    }
    const binding = account?.get(id);
    if (binding) this.persist(binding, true);
    const removed = account?.delete(id) ?? false;
    if (account?.size === 0) this.bindings.delete(key);
    return removed;
  }

  public get(domain: string, user: string): RegistrationBinding | undefined {
    const values = this.getAll(domain, user);
    return values[values.length - 1];
  }

  public getAll(domain: string, user: string): RegistrationBinding[] {
    const key = this.buildKey(domain, user), account = this.bindings.get(key);
    if (!account) return [];
    for (const [id, binding] of account) if (binding.expiresAt <= Date.now()) { account.delete(id); this.persist(binding, true); }
    if (!account.size) this.bindings.delete(key);
    return [...account.values()];
  }

  public purgeExpired(): void {
    for (const [key, account] of this.bindings) {
      for (const [id, binding] of account) if (binding.expiresAt <= Date.now()) { account.delete(id); this.persist(binding, true); }
      if (!account.size) this.bindings.delete(key);
    }
  }
}
