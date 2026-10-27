import crypto from 'crypto';
import http2 from 'http2';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApnsProvider } from '../src/push/providers/ApnsProvider';
import { FcmProvider } from '../src/push/providers/FcmProvider';
import { PushService } from '../src/push/PushService';
import { parsePushDestination } from '../src/push/PushDestination';
import { createIncomingCallNotification } from '../src/push/IncomingCallNotification';
import { createTestConfig } from './utils';

const notification = createIncomingCallNotification('call-1');
const apnsDestination = { provider: 'apns' as const, app: 'com.example.phone.voip', token: 'abcdef' };
const fcmDestination = { provider: 'fcm' as const, app: 'project', token: 'device-token' };
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rsaKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const response = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const oauth = () => response({ access_token: 'access', expires_in: 3600 });

class ApnsRequest extends EventEmitter {
  end = vi.fn();
}
class ApnsSession extends EventEmitter {
  readonly push = new ApnsRequest();
  destroy = vi.fn();
  request = vi.fn((_headers: http2.OutgoingHttpHeaders) => this.push);
}
function apnsFixture(sandbox = false) {
  const sessions: ApnsSession[] = [];
  const connect = vi.spyOn(http2, 'connect').mockImplementation((() => {
    const session = new ApnsSession(); sessions.push(session);
    return session as unknown as http2.ClientHttp2Session;
  }) as typeof http2.connect);
  const provider = new ApnsProvider({ key: ecKey, keyId: 'KEY', teamId: 'TEAM', topic: apnsDestination.app, sandbox });
  return { provider, sessions, connect };
}
function firebase() {
  return new FcmProvider({ project_id: 'project', client_email: 'service@example.test', private_key: rsaKey });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('APNs failures and resource cleanup', () => {
  it('uses production APNs and rejects provider status errors without exposing response data', async () => {
    const { provider, sessions, connect } = apnsFixture();
    const pending = provider.send(apnsDestination, notification);
    const rejected = expect(pending).rejects.toThrow('APNs rejected push (410)');
    sessions[0].emit('connect');
    sessions[0].push.emit('response', { ':status': 410 });
    sessions[0].push.emit('data', Buffer.from('sensitive-device-token'));
    sessions[0].push.emit('end');
    await rejected;
    expect(connect).toHaveBeenCalledWith('https://api.push.apple.com');
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
  });

  it.each(['connection', 'request'])('rejects an APNs %s error exactly once', async kind => {
    const { provider, sessions } = apnsFixture();
    const pending = provider.send(apnsDestination, notification);
    const rejected = expect(pending).rejects.toThrow(kind === 'connection' ? 'APNs connection failed' : 'APNs request failed');
    const session = sessions[0]; session.emit('connect');
    if (kind === 'connection') session.emit('error', new Error('secret'));
    else session.push.emit('error', new Error('secret'));
    session.push.emit('end');
    session.emit('error', new Error('late error'));
    await rejected;
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('times out an unresponsive provider and destroys its session', async () => {
    vi.useFakeTimers();
    const { provider, sessions } = apnsFixture();
    const pending = provider.send(apnsDestination, notification);
    const rejected = expect(pending).rejects.toThrow('APNs request timed out');
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews the signing token after its cache lifetime', async () => {
    vi.useFakeTimers();
    const { provider, sessions } = apnsFixture();
    const first = provider.send(apnsDestination, notification);
    sessions[0].emit('connect'); sessions[0].push.emit('response', { ':status': 200 }); sessions[0].push.emit('end');
    await first;
    await vi.advanceTimersByTimeAsync(50 * 60 * 1000 + 1);
    const second = provider.send(apnsDestination, notification);
    sessions[1].emit('connect'); sessions[1].push.emit('response', { ':status': 200 }); sessions[1].push.emit('end');
    await second;
    expect(sessions[0].request.mock.calls[0][0].authorization).not.toBe(sessions[1].request.mock.calls[0][0].authorization);
  });

  it('rejects a response without a status instead of treating it as successful', async () => {
    const { provider, sessions } = apnsFixture();
    const pending = provider.send(apnsDestination, notification);
    const rejected = expect(pending).rejects.toThrow('APNs rejected push (undefined)');
    sessions[0].emit('connect'); sessions[0].push.emit('end'); await rejected;
  });
});

describe('FCM token lifetimes, failures and concurrency', () => {
  it('shares an in-flight OAuth request across concurrent pushes', async () => {
    let accept: (value: Response) => void = () => {};
    const fetcher = vi.fn().mockReturnValueOnce(new Promise<Response>(resolve => { accept = resolve; }))
      .mockImplementation(async () => response({ name: 'sent' }));
    vi.stubGlobal('fetch', fetcher);
    const provider = firebase();
    const first = provider.send(fcmDestination, notification);
    const second = provider.send(fcmDestination, notification);
    expect(fetcher).toHaveBeenCalledTimes(1);
    accept(oauth());
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('refreshes OAuth before expiry instead of sending a nearly expired access token', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ name: 'first' }))
      .mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ name: 'second' }));
    vi.stubGlobal('fetch', fetcher);
    const provider = firebase();
    await provider.send(fcmDestination, notification);
    await vi.advanceTimersByTimeAsync(3540_000);
    await provider.send(fcmDestination, notification);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[2][0]).toBe('https://oauth2.googleapis.com/token');
  });

  it('clears a rejected in-flight OAuth request so a later call can retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({}, 403)).mockResolvedValueOnce(oauth())
      .mockResolvedValueOnce(response({ name: 'sent' }));
    vi.stubGlobal('fetch', fetcher);
    const provider = firebase();
    await expect(provider.send(fcmDestination, notification)).rejects.toThrow('FCM OAuth failed (403)');
    await expect(provider.send(fcmDestination, notification)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([{}, { access_token: 42, expires_in: 3600 }, { access_token: 'access', expires_in: '3600' }])
    ('rejects malformed OAuth payload %j', async payload => {
      const fetcher = vi.fn().mockResolvedValue(response(payload)); vi.stubGlobal('fetch', fetcher);
      await expect(firebase().send(fcmDestination, notification)).rejects.toThrow('Invalid FCM OAuth response');
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('reports FCM send rejection and transport failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(response({ token: 'secret' }, 404))
      .mockRejectedValueOnce(new Error('network unavailable'));
    vi.stubGlobal('fetch', fetcher);
    const provider = firebase();
    await expect(provider.send(fcmDestination, notification)).rejects.toThrow('FCM rejected push (404)');
    await expect(provider.send(fcmDestination, notification)).rejects.toThrow('network unavailable');
  });
});

describe('push configuration and token parsing', () => {
  it('never contacts a provider when no matching application is configured', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const service = new PushService(createTestConfig());
    expect(service.supports(fcmDestination)).toBe(false);
    expect(service.supports(apnsDestination)).toBe(false);
    await expect(service.send(fcmDestination, 'call')).rejects.toThrow('Push application is not configured');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    undefined, '', '<sip:alice@phone>',
    '<sip:alice@phone;pn-provider=unsupported;pn-param=app;pn-prid=token>',
    '<sip:alice@phone;pn-provider=fcm;pn-prid=token>',
    '<sip:alice@phone;pn-provider=fcm;pn-param=app>',
    '<sip:alice@phone;pn-provider=apns;pn-param=app;pn-prid=not-hex>',
    `<sip:alice@phone;pn-provider=fcm;pn-param=app;pn-prid=${'x'.repeat(4097)}>`,
  ])('does not accept incomplete or invalid push destination %s', contact => {
    expect(parsePushDestination(contact)).toBeUndefined();
  });

  it('accepts bare contacts, upper-case parameter names and hexadecimal APNs tokens', () => {
    expect(parsePushDestination('sip:alice@phone;PN-PROVIDER=apns;PN-PARAM=app.voip;PN-PRID=ABC012'))
      .toEqual({ provider: 'apns', app: 'app.voip', token: 'ABC012' });
  });

  it('produces stable RFC-shaped call UUIDs without merging different Call-IDs', () => {
    const first = createIncomingCallNotification('first');
    expect(first).toEqual(createIncomingCallNotification('first'));
    expect(first.call_uuid).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(first.call_uuid).not.toBe(createIncomingCallNotification('second').call_uuid);
    expect(first.call_id).toBe('first');
  });
});

it('accepts RFC 8599 APNs Team-ID.Topic parameters and rejects another team or topic', () => {
  const { provider } = apnsFixture();
  expect(provider.supports({ ...apnsDestination, app: `TEAM.${apnsDestination.app}` })).toBe(true);
  expect(provider.supports(apnsDestination)).toBe(true);
  expect(provider.supports({ ...apnsDestination, app: `OTHER.${apnsDestination.app}` })).toBe(false);
  expect(provider.supports({ ...apnsDestination, app: 'TEAM.com.other.voip' })).toBe(false);
});
