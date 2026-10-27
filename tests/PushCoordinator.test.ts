import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushCoordinator } from '../src/push/PushCoordinator';
import { parsePushDestination } from '../src/push/PushService';
import { RegistrationBinding, RegistrationStore } from '../src/store';
import { SipMessage } from '../src/sip';
import { createTestLogger } from './utils';

const request = (method = 'INVITE', callId = 'call') => new SipMessage([
  `${method} sip:alice@203.0.113.5 SIP/2.0`,
  'Via: SIP/2.0/UDP 10.0.0.1;branch=z9hG4bK-original',
  `Call-ID: ${callId}`, `CSeq: 1 ${method}`, 'Content-Length: 0', '', '',
].join('\r\n'));
const binding = (): RegistrationBinding => ({
  domain: 'pbx.example', user: 'alice', clientAddress: '192.0.2.1', clientPort: 5060,
  transport: 'UDP', expiresAt: Date.now() + 60000,
  push: { provider: 'fcm', token: 'secret', app: 'our-project' },
});

describe('mobile wake-up', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('parses push parameters only inside Contact URI, preserving encoded token data', () => {
    expect(parsePushDestination('<sip:alice@phone;pn-provider=fcm;pn-param=our-project;pn-prid=a%3Ab>')).toEqual({
      provider: 'fcm', app: 'our-project', token: 'a:b',
    });
    expect(parsePushDestination('<sip:alice@phone>;pn-provider=fcm;pn-param=our-project;pn-prid=secret')).toBeUndefined();
    expect(parsePushDestination('<sip:alice@phone;pn-provider=fcm;pn-param=x;pn-prid=%xx>')).toBeUndefined();
  });

  it('deduplicates retransmissions and waits for the correct tenant and user to register', async () => {
    const store = new RegistrationStore();
    const sender = { supports: () => true, send: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new PushCoordinator(store, sender, createTestLogger());
    const ready = vi.fn(), fail = vi.fn(), trying = vi.fn();
    expect(coordinator.enqueue(request(), 'pbx', binding(), { ready, fail, trying })).toBe(true);
    coordinator.enqueue(request(), 'pbx', binding(), { ready, fail, trying });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    store.upsert({ ...binding(), domain: 'other.example' });
    store.upsert({ ...binding(), user: 'Alice' });
    await new Promise(resolve => setImmediate(resolve));
    expect(ready).not.toHaveBeenCalled();
    const fresh = { ...binding(), clientPort: 5099 };
    store.upsert(fresh);
    await new Promise(resolve => setImmediate(resolve));
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(fresh);
    expect(fail).not.toHaveBeenCalled();
    coordinator.enqueue(request(), 'pbx', binding(), { ready, fail });
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('cancels only the matching source and never resumes a cancelled call', async () => {
    const store = new RegistrationStore();
    const coordinator = new PushCoordinator(store, { supports: () => true, send: async () => {} }, createTestLogger());
    const ready = vi.fn(), fail = vi.fn();
    coordinator.enqueue(request(), 'pbx', binding(), { ready, fail });
    expect(coordinator.cancel(request('CANCEL'), 'attacker')).toBe(false);
    expect(coordinator.cancel(request('CANCEL'), 'pbx')).toBe(true);
    expect(fail).toHaveBeenCalledWith(487, 'Request Terminated');
    store.upsert(binding());
    await new Promise(resolve => setImmediate(resolve));
    expect(ready).not.toHaveBeenCalled();
  });

  it('times out once and caches the final response for retransmissions', () => {
    const coordinator = new PushCoordinator(new RegistrationStore(), { supports: () => true, send: async () => {} }, createTestLogger());
    const fail = vi.fn();
    coordinator.enqueue(request(), 'pbx', binding(), { ready: vi.fn(), fail });
    vi.advanceTimersByTime(25000);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(480, 'Temporarily Unavailable');
    coordinator.enqueue(request(), 'pbx', binding(), { ready: vi.fn(), fail });
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it('bounds memory and reports push provider failures without token leakage', async () => {
    const sender = { supports: () => true, send: vi.fn().mockRejectedValue(new Error('secret')) };
    const logger = createTestLogger();
    const coordinator = new PushCoordinator(new RegistrationStore(), sender, logger, { maxEntries: 1 });
    const fail = vi.fn();
    coordinator.enqueue(request(), 'pbx', binding(), { ready: vi.fn(), fail });
    coordinator.enqueue(request('INVITE', 'another'), 'pbx', binding(), { ready: vi.fn(), fail });
    expect(fail).toHaveBeenCalledWith(503, 'Service Unavailable');
    await new Promise(resolve => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith('Mobile push delivery failed');
  });
  it('honors CANCEL arriving between accepted REGISTER and deferred INVITE delivery', async () => {
    const store = new RegistrationStore();
    const coordinator = new PushCoordinator(store, { supports: () => true, send: async () => {} }, createTestLogger());
    const ready = vi.fn(), fail = vi.fn();
    coordinator.enqueue(request(), 'pbx', binding(), { ready, fail });
    store.upsert(binding());
    expect(coordinator.cancel(request('CANCEL'), 'pbx')).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(ready).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(487, 'Request Terminated');
  });

  it('disposes listeners and timers without delivering a deferred call', async () => {
    const store = new RegistrationStore();
    const coordinator = new PushCoordinator(store, { supports: () => true, send: async () => {} }, createTestLogger());
    const ready = vi.fn(), fail = vi.fn();
    coordinator.enqueue(request(), 'pbx', binding(), { ready, fail });
    store.upsert(binding());
    coordinator.dispose();
    store.upsert(binding());
    await new Promise(resolve => setImmediate(resolve));
    vi.advanceTimersByTime(180_000);
    expect(ready).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a provider failure arriving after disposal', async () => {
    let rejectPush: (error: Error) => void = () => {};
    const sender = { supports: () => true, send: () => new Promise<void>((_resolve, reject) => { rejectPush = reject; }) };
    const coordinator = new PushCoordinator(new RegistrationStore(), sender, createTestLogger());
    const fail = vi.fn();
    coordinator.enqueue(request(), 'pbx', binding(), { ready: vi.fn(), fail });
    coordinator.dispose();
    rejectPush(new Error('provider failed'));
    await new Promise(resolve => setImmediate(resolve));
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a refreshed device that switches to an unsupported transport', () => {
    const store = new RegistrationStore();
    const coordinator = new PushCoordinator(store, { supports: () => true, send: async () => {} }, createTestLogger());
    const ready = vi.fn(), fail = vi.fn();
    coordinator.enqueue(request(), 'pbx', binding(), { ready, fail });
    store.upsert({ ...binding(), transport: 'TLS' });
    expect(ready).not.toHaveBeenCalled(); expect(fail).toHaveBeenCalledWith(480, 'Temporarily Unavailable');
    coordinator.dispose();
  });

  it('does not intercept unsupported devices or noninitial requests', () => {
    const sender = { supports: () => false, send: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new PushCoordinator(new RegistrationStore(), sender, createTestLogger());
    const handlers = { ready: vi.fn(), fail: vi.fn() };
    expect(coordinator.enqueue(request(), 'pbx', binding(), handlers)).toBe(false);
    expect(coordinator.enqueue(request('BYE'), 'pbx', binding(), handlers)).toBe(false);
    const noPush = binding(); delete noPush.push;
    expect(coordinator.enqueue(request(), 'pbx', noPush, handlers)).toBe(false);
    expect(sender.send).not.toHaveBeenCalled(); coordinator.dispose();
  });

  it('expires cached failures and released entries so later transactions can send a new push', async () => {
    const store = new RegistrationStore(); const sender = { supports: () => true, send: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new PushCoordinator(store, sender, createTestLogger()); const handlers = { ready: vi.fn(), fail: vi.fn() };
    coordinator.enqueue(request(), 'pbx', binding(), handlers); vi.advanceTimersByTime(25_000 + 32_000);
    coordinator.enqueue(request(), 'pbx', binding(), handlers); expect(sender.send).toHaveBeenCalledTimes(2);
    store.upsert(binding()); await new Promise(resolve => setImmediate(resolve));
    expect(coordinator.cancel(request('CANCEL'), 'pbx')).toBe(false);
    vi.advanceTimersByTime(180_000); coordinator.enqueue(request(), 'pbx', binding(), handlers);
    expect(sender.send).toHaveBeenCalledTimes(3); coordinator.dispose();
  });

  it('keeps a released call delivered if its push provider fails later', async () => {
    let reject: (error: Error) => void = () => {};
    const sender = { supports: () => true, send: () => new Promise<void>((_resolve, fail) => { reject = fail; }) };
    const store = new RegistrationStore(); const coordinator = new PushCoordinator(store, sender, createTestLogger());
    const ready = vi.fn(), fail = vi.fn(); coordinator.enqueue(request(), 'pbx', binding(), { ready, fail });
    store.upsert(binding()); await new Promise(resolve => setImmediate(resolve));
    reject(new Error('late provider failure')); await new Promise(resolve => setImmediate(resolve));
    expect(ready).toHaveBeenCalledTimes(1); expect(fail).not.toHaveBeenCalled(); coordinator.dispose();
  });

});

it('keeps device-specific calls waiting when another device on the same account registers', async () => {
  const store = new RegistrationStore();
  const coordinator = new PushCoordinator(store, { supports: () => true, send: async () => {} }, createTestLogger());
  const ready = vi.fn(), fail = vi.fn();
  coordinator.enqueue(request(), 'pbx', binding(), { ready, fail });
  store.upsert({ ...binding(), push: { provider: 'fcm', app: 'our-project', token: 'other-device' } });
  store.upsert({ ...binding(), push: { provider: 'fcm', app: 'other-project', token: 'secret' } });
  store.upsert({ ...binding(), push: { provider: 'apns', app: 'our-project', token: 'secret' } });
  store.upsert({ ...binding(), push: undefined });
  await new Promise(resolve => setImmediate(resolve));
  expect(ready).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
  store.upsert(binding());
  await new Promise(resolve => setImmediate(resolve));
  expect(ready).toHaveBeenCalledOnce(); coordinator.dispose();
});

it('shares cancellation and failed ACK handling through the transport-facing API', () => {
  const coordinator = new PushCoordinator(new RegistrationStore(), { supports: () => true, send: async () => {} }, createTestLogger());
  const handlers = { deliver: vi.fn(), respond: vi.fn() };
  expect(coordinator.handleRequest(request('ACK'), 'unknown', binding(), handlers)).toBe(false);
  expect(coordinator.handleRequest(request('INVITE'), 'pbx', binding(), handlers)).toBe(true);
  expect(handlers.respond).toHaveBeenCalledWith(100, 'Trying');
  expect(coordinator.handleRequest(request('CANCEL'), 'pbx', binding(), handlers)).toBe(true);
  expect(handlers.respond).toHaveBeenCalledWith(487, 'Request Terminated');
  expect(handlers.respond).toHaveBeenLastCalledWith(200, 'OK');
  expect(coordinator.handleRequest(request('ACK'), 'pbx', binding(), handlers)).toBe(true);
  expect(handlers.deliver).not.toHaveBeenCalled(); coordinator.dispose();
});
