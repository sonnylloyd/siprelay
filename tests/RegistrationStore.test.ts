import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistrationBinding, RegistrationStore } from '../src/store';

const binding = (overrides: Partial<RegistrationBinding> = {}): RegistrationBinding => ({
  domain: 'pbx.example', user: 'Alice', clientAddress: '192.0.2.1', clientPort: 5060,
  expiresAt: Date.now() + 60_000, ...overrides,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('registration store isolation and lifetimes', () => {
  it('normalizes domain case while keeping user names case-sensitive', () => {
    const store = new RegistrationStore();
    store.upsert(binding());
    expect(store.get('PBX.EXAMPLE', 'Alice')).toBeDefined();
    expect(store.get('pbx.example', 'alice')).toBeUndefined();
    expect(store.get('other.example', 'Alice')).toBeUndefined();
  });

  it('does not collide accounts containing key delimiters', () => {
    const store = new RegistrationStore();
    store.upsert(binding({ domain: 'a|b', user: 'c' }));
    store.upsert(binding({ domain: 'a', user: 'b|c', clientPort: 5099 }));
    expect(store.get('a|b', 'c')?.clientPort).toBe(5060);
    expect(store.get('a', 'b|c')?.clientPort).toBe(5099);
  });

  it('replaces an accepted binding and removes it case-insensitively by domain', () => {
    const store = new RegistrationStore();
    store.upsert(binding());
    store.upsert(binding({ clientPort: 5099 }));
    expect(store.get('pbx.example', 'Alice')?.clientPort).toBe(5099);
    expect(store.remove('PBX.EXAMPLE', 'Alice')).toBe(true);
    expect(store.remove('pbx.example', 'Alice')).toBe(false);
    expect(store.get('pbx.example', 'Alice')).toBeUndefined();
  });

  it('expires at the exact boundary and retains unexpired bindings during purge', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const store = new RegistrationStore();
    store.upsert(binding({ user: 'expired', expiresAt: 1000 }));
    store.upsert(binding({ user: 'future', expiresAt: 1001 }));
    expect(store.get('pbx.example', 'expired')).toBeUndefined();
    store.upsert(binding({ user: 'also-expired', expiresAt: 999 }));
    store.purgeExpired();
    expect(store.get('pbx.example', 'also-expired')).toBeUndefined();
    expect(store.get('pbx.example', 'future')).toBeDefined();
  });

  it('notifies subscribers after storage and allows an individual subscriber to unsubscribe', () => {
    const store = new RegistrationStore();
    const first = vi.fn((accepted: RegistrationBinding) => {
      expect(store.get(accepted.domain, accepted.user)).toBe(accepted);
    });
    const second = vi.fn();
    const unsubscribe = store.onRegistered(first);
    store.onRegistered(second);
    store.upsert(binding());
    unsubscribe();
    unsubscribe();
    store.upsert(binding({ clientPort: 5099 }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});

it('removes one Contact without removing another and removes an empty account', () => {
  const store = new RegistrationStore();
  store.upsert(binding({ id: 'one' })); store.upsert(binding({ id: 'two' }));
  expect(store.remove('pbx.example', 'Alice', 'one')).toBe(true);
  expect(store.getAll('pbx.example', 'Alice').map(item => item.id)).toEqual(['two']);
  expect(store.remove('pbx.example', 'Alice', 'two')).toBe(true);
  expect(store.getAll('pbx.example', 'Alice')).toEqual([]);
});
