import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistrationService } from '../src/sip/RegistrationService';
import { SipMessage } from '../src/sip/SipMessage';
import { RegistrationStore } from '../src/store/RegistrationStore';
import { createTestLogger } from './utils';

const buildRegisterRequest = (callId = 'abc123'): SipMessage =>
  new SipMessage(
    [
      'REGISTER sip:example.com SIP/2.0',
      'To: <sip:alice@example.com>',
      'From: <sip:alice@example.com>;tag=tag1',
      `Call-ID: ${callId}`,
      'CSeq: 1 REGISTER',
      'Contact: <sip:alice@192.0.2.10:5060>',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n')
  );

const buildRegisterResponse = (callId = 'abc123', contact: string, expires?: number): SipMessage => {
  const headers = [
    'SIP/2.0 200 OK',
    `Via: SIP/2.0/UDP 203.0.113.5:15060;branch=${buildRegisterRequest(callId).generateBranch()}`,
    `Call-ID: ${callId}`,
    'CSeq: 1 REGISTER',
    `Contact: ${contact}`,
  ];
  if (expires !== undefined) {
    headers.push(`Expires: ${expires}`);
  }
  headers.push('Content-Length: 0', '', '');
  return new SipMessage(headers.join('\r\n'));
};

describe('RegistrationService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores a registration on successful REGISTER response', () => {
    const store = new RegistrationStore();
    const logger = createTestLogger();
    const service = new RegistrationService(store, logger, 30000);

    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const request = buildRegisterRequest();
    service.trackRequest(request, { address: '192.0.2.10', port: 5060 });

    const response = buildRegisterResponse('abc123', '<sip:alice@192.0.2.10:5060>;expires=120');
    service.handleResponse(response);

    const binding = store.get('example.com', 'alice');
    expect(binding).toBeTruthy();
    expect(binding?.clientAddress).toBe('192.0.2.10');
    expect(binding?.expiresAt).toBe(now + 120 * 1000);
  });

  it('removes registration when expires is zero', () => {
    const store = new RegistrationStore();
    const logger = createTestLogger();
    const service = new RegistrationService(store, logger, 30000);

    store.upsert({
      domain: 'example.com',
      user: 'alice',
      clientAddress: '192.0.2.10',
      clientPort: 5060,
      expiresAt: Date.now() + 60000,
    });

    const request = buildRegisterRequest();
    service.trackRequest(request, { address: '192.0.2.10', port: 5060 });

    const response = buildRegisterResponse('abc123', '*', 0);
    service.handleResponse(response);

    const binding = store.get('example.com', 'alice');
    expect(binding).toBeUndefined();
  });
  it('ignores provisional and unrelated CSeq responses until the matching final response', () => {
    const store = new RegistrationStore();
    const service = new RegistrationService(store, createTestLogger());
    service.trackRequest(buildRegisterRequest(), { address: '192.0.2.10', port: 5060 });
    service.handleResponse(new SipMessage(buildRegisterResponse('abc123', '*', 0).toString().replace('200 OK', '100 Trying')));
    service.handleResponse(new SipMessage(buildRegisterResponse('abc123', '*', 0).toString().replace('CSeq: 1', 'CSeq: 2')));
    service.handleResponse(buildRegisterResponse('abc123', '<sip:alice@192.0.2.10>;expires=60'));
    expect(store.get('example.com', 'alice')).toBeTruthy();
  });

  it('does not create bindings from queries, failed authentication or another tenant AoR', () => {
    const store = new RegistrationStore();
    const service = new RegistrationService(store, createTestLogger());
    const query = buildRegisterRequest(); query.removeHeader('Contact');
    service.trackRequest(query, { address: '192.0.2.10', port: 5060 });
    service.handleResponse(buildRegisterResponse('abc123', '<sip:alice@192.0.2.10>;expires=60'));
    expect(store.get('example.com', 'alice')).toBeUndefined();
    service.trackRequest(buildRegisterRequest(), { address: '192.0.2.10', port: 5060 });
    service.handleResponse(new SipMessage(buildRegisterResponse('abc123', '*', 0).toString().replace('200 OK', '401 Unauthorized')));
    expect(store.get('example.com', 'alice')).toBeUndefined();
    const otherTenant = buildRegisterRequest(); otherTenant.setHeader('To', '<sip:alice@victim.example>');
    service.trackRequest(otherTenant, { address: '192.0.2.10', port: 5060 });
    service.handleResponse(buildRegisterResponse('abc123', '<sip:alice@192.0.2.10>;expires=60'));
    expect(store.get('victim.example', 'alice')).toBeUndefined();
  });

});
