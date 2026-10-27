import crypto from 'node:crypto';
import type { RegistrationBinding } from '../RegistrationStore';

/** Deliberately excludes sockets, source addresses, Contact headers and SIP authentication headers. The binding id may be a Contact URI. */
export type SavedDevice = Pick<RegistrationBinding, 'domain' | 'user' | 'id' | 'transport' | 'push' | 'expiresAt' | 'flowToken'>;
export interface StoredState { secret: Buffer; devices: SavedDevice[] }
export interface DeviceChange { key: string; device?: SavedDevice }

/** One database belongs to one running relay. This is persistence, not clustering. */
export interface PushStorage {
  open(): Promise<StoredState>;
  write(changes: DeviceChange[]): Promise<void>;
  close(): Promise<void>;
}

export function deviceKey(device: Pick<RegistrationBinding, 'domain' | 'user' | 'id'>): string {
  return crypto.createHash('sha256').update(JSON.stringify([device.domain.toLowerCase(), device.user, device.id ?? 'legacy'])).digest('hex');
}

export function saveDevice(binding: RegistrationBinding): SavedDevice | undefined {
  if (!binding.push || binding.expiresAt <= Date.now()) return;
  const { domain, user, id, transport, push, expiresAt, flowToken } = binding;
  return { domain: domain.toLowerCase(), user, id, transport: transport ?? 'UDP', push: { ...push }, expiresAt, flowToken };
}

/** A damaged or incompatible database must not silently become an empty registrar. */
export function readDevice(payload: string): SavedDevice {
  const value = JSON.parse(payload) as SavedDevice;
  if (!value || typeof value.domain !== 'string' || !value.domain || typeof value.user !== 'string' || !value.user ||
      (value.id !== undefined && typeof value.id !== 'string') ||
      !['UDP', 'TCP', 'TLS'].includes(value.transport as string) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0 ||
      (value.flowToken !== undefined && typeof value.flowToken !== 'string') ||
      !value.push || !['apns', 'fcm'].includes(value.push.provider) ||
      typeof value.push.app !== 'string' || !value.push.app || typeof value.push.token !== 'string' || !value.push.token) {
    throw new Error('Invalid push storage record');
  }
  // Rebuild the whitelist rather than trusting extra fields in stored JSON.
  const { domain, user, id, transport, expiresAt, flowToken, push } = value;
  return { domain, user, id, transport, expiresAt, flowToken, push: { provider: push.provider, app: push.app, token: push.token } };
}

export function readSecret(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid push storage signing key');
  return Buffer.from(value, 'hex');
}

export class MemoryPushStorage implements PushStorage {
  async open(): Promise<StoredState> { return { secret: crypto.randomBytes(32), devices: [] }; }
  async write(_changes: DeviceChange[]): Promise<void> { /* Process-only registrations are owned by RegistrationStore. */ }
  async close(): Promise<void> { /* No resources. */ }
}
