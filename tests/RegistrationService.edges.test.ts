import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistrationService } from '../src/sip/RegistrationService';
import { RegistrationStore } from '../src/store';
import { createTestLogger } from './utils';
import { sipRequest, sipResponse } from './fixtures/sip';
import { FakeTlsSocket } from './fixtures/transports';
import { SipMessage } from '../src/sip';

function fixture() {
  const store = new RegistrationStore(); const logger = createTestLogger();
  const service = new RegistrationService(store, logger, 1000);
  const request = sipRequest({ method: 'REGISTER', target: 'pbx.internal' });
  const client = { address: '192.0.2.1', port: 55000 };
  const response = (message = request, status = 200) => {
    const forwarded = new SipMessage(message.toString());
    forwarded.addViaTop(`SIP/2.0/UDP relay;branch=${message.generateBranch()}`);
    return sipResponse(forwarded, status);
  };
  return { store, service, request, response, client, logger };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('accepted registration metadata and expiry', () => {
  it('prefers Contact expiry over global expiry and the requested lifetime', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { service, request, response, store, client } = fixture();
    request.setHeader('Expires', '3600'); service.trackRequest(request, client);
    const accepted = response(); accepted.setHeader('Expires', '600');
    accepted.setHeader('Contact', '<sip:alice@relay>;expires=120'); service.handleResponse(accepted);
    expect(store.get('pbx.internal', 'alice')?.expiresAt).toBe(121_000);
  });

  it('uses an explicitly requested expiry when the registrar omits it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { service, request, response, store, client } = fixture();
    request.setHeader('Expires', '60'); service.trackRequest(request, client); service.handleResponse(response());
    expect(store.get('pbx.internal', 'alice')?.expiresAt).toBe(61_000);
  });

  it.each(['-1', '1junk', '9007199254740993'])('does not invent a lifetime from malformed Contact expiry %s', expiry => {
    const { service, request, response, store, client } = fixture();
    service.trackRequest(request, client);
    const accepted = response(); accepted.setHeader('Contact', `<sip:alice@relay>;expires=${expiry}`);
    service.handleResponse(accepted); expect(store.get('pbx.internal', 'alice')).toBeUndefined();
  });

  it('refuses an unspecified expiry and malformed global expiry', () => {
    const { service, request, response, store, client } = fixture();
    service.trackRequest(request, client); service.handleResponse(response());
    expect(store.get('pbx.internal', 'alice')).toBeUndefined();
    service.trackRequest(request, client); const accepted = response(); accepted.setHeader('Expires', '60junk');
    service.handleResponse(accepted); expect(store.get('pbx.internal', 'alice')).toBeUndefined();
  });

  it('retains original device push parameters and its TLS socket when PBX response strips them', () => {
    const { service, request, response, store, client } = fixture();
    const socket = new FakeTlsSocket().asSocket();
    const contact = '<sip:alice@device;transport=tls;pn-provider=fcm;pn-param=project;pn-prid=secret>';
    request.setHeader('Contact', contact);
    service.trackRequest(request, { ...client, transport: 'TLS', socket });
    const accepted = response(); accepted.setHeader('Contact', '<sip:alice@relay>;expires=120'); service.handleResponse(accepted);
    expect(store.get('pbx.internal', 'alice')).toMatchObject({ clientContact: contact, transport: 'TLS', socket,
      push: { provider: 'fcm', app: 'project', token: 'secret' }, clientAddress: client.address, clientPort: client.port });
  });

  it('does not mistake an asterisk inside a legal contact user for wildcard removal', () => {
    const { service, request, response, store, client } = fixture(); service.trackRequest(request, client);
    const accepted = response(); accepted.setHeader('Contact', '<sip:alice*phone@relay>;expires=120'); service.handleResponse(accepted);
    expect(store.get('pbx.internal', 'alice')).toBeDefined();
  });

  it('removes only the matching tenant binding on accepted wildcard unregister', () => {
    const { service, request, response, store, client } = fixture();
    store.upsert({ domain: 'other.internal', user: 'alice', clientAddress: '192.0.2.2', clientPort: 5060, expiresAt: Date.now() + 60000 });
    request.setHeader('Contact', '*'); request.setHeader('Expires', '0'); service.trackRequest(request, client);
    const accepted = response(); accepted.setHeader('Contact', '*'); accepted.setHeader('Expires', '0'); service.handleResponse(accepted);
    expect(store.get('other.internal', 'alice')).toBeDefined();
    expect(store.get('pbx.internal', 'alice')).toBeUndefined();
  });
});

describe('pending registration authentication and lifetimes', () => {
  it('ignores responses arriving after pending registration expiry', () => {
    vi.useFakeTimers(); const { service, request, response, store, client } = fixture();
    service.trackRequest(request, client); vi.advanceTimersByTime(1000);
    const accepted = response(); accepted.setHeader('Expires', '60'); service.handleResponse(accepted);
    expect(store.get('pbx.internal', 'alice')).toBeUndefined();
  });

  it('renews pending expiry for retransmissions without leaking timers', () => {
    vi.useFakeTimers(); const { service, request, response, store, client } = fixture();
    service.trackRequest(request, client); vi.advanceTimersByTime(900); service.trackRequest(request, client);
    vi.advanceTimersByTime(200); const accepted = response(); accepted.setHeader('Expires', '60'); service.handleResponse(accepted);
    expect(store.get('pbx.internal', 'alice')).toBeDefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accept the wrong proxy branch and keeps the matching request pending', () => {
    const { service, request, response, store, client } = fixture(); service.trackRequest(request, client);
    const accepted = response(); accepted.setHeader('Expires', '60');
    const wrong = new SipMessage(accepted.toString()); wrong.setHeader('Via', 'SIP/2.0/UDP relay;branch=wrong');
    service.handleResponse(wrong); expect(store.get('pbx.internal', 'alice')).toBeUndefined();
    service.handleResponse(accepted); expect(store.get('pbx.internal', 'alice')).toBeDefined();
  });

  it.each([401, 403, 407, 500])('does not overwrite an accepted binding after final status %i', status => {
    const { service, request, response, store, client } = fixture();
    store.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: 'old-client', clientPort: 5060, expiresAt: Date.now() + 60000 });
    service.trackRequest(request, client); service.handleResponse(response(request, status));
    expect(store.get('pbx.internal', 'alice')?.clientAddress).toBe('old-client');
    const late = response(); late.setHeader('Expires', '60'); service.handleResponse(late);
    expect(store.get('pbx.internal', 'alice')?.clientAddress).toBe('old-client');
  });

  it('ignores missing identities and unsolicited responses', () => {
    const { service, request, response, store, client } = fixture();
    service.handleResponse(response());
    request.removeHeader('Call-ID'); service.trackRequest(request, client); service.handleResponse(response());
    expect(store.get('pbx.internal', 'alice')).toBeUndefined();
  });
});


it('bounds pending registrations and never installs metadata from an overflow request', () => {
  const { service, request, response, store, client } = fixture();
  const pending = (service as unknown as { pending: Map<string, unknown> }).pending;
  for (let i = 0; i < 10_000; i++) pending.set(String(i), {});
  service.trackRequest(request, client); service.handleResponse(response());
  expect(store.get('pbx.internal', 'alice')).toBeUndefined(); expect(pending.size).toBe(10_000);
});

it('never tracks ordinary requests as registrations', () => {
  const { service, client } = fixture(); service.trackRequest(sipRequest(), client);
  expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
});

it('ignores a response whose Call-ID is absent rather than creating a binding', () => {
  const { service, request, response, store, client } = fixture(); service.trackRequest(request, client);
  const missing = response(); missing.removeHeader('Call-ID'); service.handleResponse(missing);
  expect(store.get('pbx.internal', 'alice')).toBeUndefined();
});
