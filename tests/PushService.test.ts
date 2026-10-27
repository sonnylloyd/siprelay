import { parseFirebaseServiceAccount } from '../src/push/providers/FcmProvider';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import http2 from 'http2';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PushService } from '../src/push/PushService';
import { createTestConfig } from './utils';

const dirs: string[] = [];
function file(name: string, value: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siprelay-push-'));
  dirs.push(dir);
  const target = path.join(dir, name); fs.writeFileSync(target, value); return target;
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

describe('native push providers', () => {
  it.each(['null', '{}', '{"project_id":42,"client_email":"app@example.test","private_key":"key"}'])
    ('rejects malformed FCM credentials: %s', json => {
      expect(() => parseFirebaseServiceAccount(json)).toThrow('FCM service account requires');
    });

  it('uses FCM HTTP v1, signed OAuth and a cached access token', async () => {
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const serviceAccount = file('account.json', JSON.stringify({ project_id: 'our-project',
      client_email: 'push@example.test', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }));
    const fetcher = vi.fn(async (url: string) => url.includes('oauth2') ? {
      ok: true, json: async () => ({ access_token: 'access-token', expires_in: 3600 }),
    } : { ok: true, arrayBuffer: async () => new ArrayBuffer(0) });
    vi.stubGlobal('fetch', fetcher);
    const service = new PushService(createTestConfig({ PUSH_FCM_SERVICE_ACCOUNT_PATH: serviceAccount }));
    expect(service.supports({ provider: 'fcm', token: 'device', app: 'another-project' })).toBe(false);
    await service.send({ provider: 'fcm', token: 'device', app: 'our-project' }, 'call');
    await service.send({ provider: 'fcm', token: 'device', app: 'our-project' }, 'call');
    expect(fetcher).toHaveBeenCalledTimes(3);
    const oauthOptions = (fetcher.mock.calls[0] as any)[1];
    const assertion = oauthOptions.body.get('assertion');
    const [header, claims, signature] = assertion.split('.');
    expect(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString()).aud).toBe('https://oauth2.googleapis.com/token');
    const options = (fetcher.mock.calls[1] as any)[1];
    expect(options.headers.Authorization).toBe('Bearer access-token');
    const payload = JSON.parse(options.body);
    expect(payload.message.android).toEqual({ priority: 'high', ttl: '25s' });
    expect(payload.message.data.call_id).toBe('call');
  });

  it.each(['com.example.phone.voip', 'TEAM.com.example.phone.voip'])('sends APNs VoIP with the correct topic for SIP app parameter %s', async app => {
    const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyPath = file('key.p8', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const headers: any[] = [], bodies: any[] = [];
    const connect = vi.spyOn(http2, 'connect').mockImplementation((() => {
      const session = new EventEmitter() as any;
      session.destroy = vi.fn();
      session.request = (header: any) => {
        headers.push(header);
        const request = new EventEmitter() as any;
        request.end = (body: string) => {
          bodies.push(JSON.parse(body));
          setImmediate(() => { request.emit('response', { ':status': 200 }); request.emit('end'); });
        };
        return request;
      };
      setImmediate(() => session.emit('connect'));
      return session;
    }) as any);
    const service = new PushService(createTestConfig({ PUSH_APNS_KEY_PATH: keyPath,
      PUSH_APNS_KEY_ID: 'KEY', PUSH_APNS_TEAM_ID: 'TEAM', PUSH_APNS_TOPIC: 'com.example.phone.voip', PUSH_APNS_SANDBOX: true,
    }));
    await service.send({ provider: 'apns', token: 'abcdef', app }, 'call');
    await service.send({ provider: 'apns', token: 'abcdef', app }, 'call');
    expect(connect).toHaveBeenCalledWith('https://api.sandbox.push.apple.com');
    expect(headers[0]['apns-push-type']).toBe('voip');
    expect(headers.map(header => header['apns-topic'])).toEqual(['com.example.phone.voip', 'com.example.phone.voip']);
    expect(headers[0].authorization).toBe(headers[1].authorization);
    const token = headers[0].authorization.slice(7);
    const [header, claims, signature] = token.split('.');
    expect(crypto.verify('sha256', Buffer.from(`${header}.${claims}`), {
      key: keys.publicKey, dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(bodies[0].call_uuid).toBe(bodies[1].call_uuid);
    expect(bodies[0].call_id).toBe('call');
  });
});
