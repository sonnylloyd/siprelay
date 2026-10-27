import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogGuard } from '../src/security/DialogGuard';
import { parsePushDestination } from '../src/push/PushDestination';
import { IngressLimiter } from '../src/security/IngressLimiter';
import { SipMessage } from '../src/sip';
import { parseSipUri, readAddressTag, splitNameAddress } from '../src/sip/SipUri';
import { sipRequest, sipResponse } from './fixtures/sip';
import { PbxRouteResolver } from '../src/proxies/PbxRouteResolver';
import { MemoryStore } from '../src/store';
import { SipResponseValidator } from '../src/sip/SipResponseValidator';
import { FakeTlsSocket } from './fixtures/transports';
import { createTestLogger } from './utils';

const domain = 'pbx.internal', flow = 'tls:phone';
function control(method = 'BYE') {
  const message = sipRequest({ method, cseq: 2 });
  message.setHeader('To', '<sip:alice@pbx.internal>;tag=callee');
  return message;
}
function established(guard: DialogGuard, status = 200) {
  const invite = sipRequest();
  guard.trackInvite(invite, domain, flow);
  guard.observeResponse(sipResponse(invite, status), guard.context(invite, domain, flow));
}
afterEach(() => vi.useRealTimers());

describe('call-control authorization', () => {
  it.each(['BYE', 'REFER', 'INFO', 'UPDATE', 'PRACK', 'ACK', 'NOTIFY', 'INVITE'])
    ('pins in-dialog %s to the phone flow and tenant', method => {
      const guard = new DialogGuard(); established(guard);
      const request = control(method);
      expect(guard.authorize(request, domain, flow)).toBe(true);
      expect(guard.authorize(request, domain, 'tls:attacker')).toBe(false);
      expect(guard.authorize(request, 'other.internal', flow)).toBe(false);
      request.setHeader('Call-ID', 'guessed-call');
      expect(guard.authorize(request, domain, flow)).toBe(false);
    });

  it.each(['BYE', 'REFER', 'INFO', 'UPDATE', 'PRACK', 'ACK', 'NOTIFY'])('rejects out-of-dialog %s', method => {
    expect(new DialogGuard().authorize(sipRequest({ method }), domain, flow)).toBe(false);
  });

  it('allows initial requests for PBX authentication and tagless responses create no dialog', () => {
    const guard = new DialogGuard(); const request = sipRequest();
    expect(guard.authorize(request, domain, flow)).toBe(true);
    expect(guard.trackInvite(sipRequest({ method: 'REGISTER' }), domain, flow)).toBe(true);
    const response = sipResponse(request); response.setHeader('To', '<sip:alice@pbx.internal>');
    guard.observeResponse(response, guard.context(request, domain, flow));
    expect(guard.authorize(control(), domain, flow)).toBe(false);
  });

  it('requires CANCEL to match the original flow, branch, Call-ID, sequence and From tag', () => {
    const guard = new DialogGuard(); const invite = sipRequest(); guard.trackInvite(invite, domain, flow);
    const cancel = sipRequest({ method: 'CANCEL' });
    expect(guard.authorize(cancel, domain, flow)).toBe(true);
    expect(guard.authorize(cancel, domain, 'tls:attacker')).toBe(false);
    for (const [name, value] of [['CSeq', '2 CANCEL'], ['Call-ID', 'other'], ['From', '<sip:bob@example.com>;tag=other'],
      ['Via', 'SIP/2.0/TLS phone;branch=other']]) {
      const forged = new SipMessage(cancel.toString()); forged.setHeader(name, value);
      expect(guard.authorize(forged, domain, flow)).toBe(false);
    }
    guard.observeResponse(sipResponse(invite), guard.context(invite, domain, flow));
    expect(guard.authorize(cancel, domain, flow)).toBe(false);
  });

  it('allows non-success ACK only on the original flow and expires it after 32 seconds', () => {
    vi.useFakeTimers(); const guard = new DialogGuard(); established(guard, 486);
    expect(guard.authorize(control('ACK'), domain, flow)).toBe(true);
    expect(guard.authorize(control(), domain, flow)).toBe(false);
    vi.advanceTimersByTime(32_000);
    expect(guard.authorize(control('ACK'), domain, flow)).toBe(false);
  });

  it('allows early PRACK and reversed dialog direction, then expires an abandoned dialog', () => {
    vi.useFakeTimers(); const guard = new DialogGuard(); established(guard, 183);
    const reversed = control('PRACK');
    reversed.setHeader('From', '<sip:alice@pbx.internal>;tag=callee');
    reversed.setHeader('To', '<sip:bob@example.com>;tag=caller');
    expect(guard.authorize(reversed, domain, flow)).toBe(true);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(guard.authorize(reversed, domain, flow)).toBe(false);
  });

  it('expires early dialogs and pending INVITEs without extending them from attacker traffic', () => {
    vi.useFakeTimers(); const guard = new DialogGuard(); established(guard, 180);
    vi.advanceTimersByTime(180_000);
    expect(guard.authorize(control(), domain, flow)).toBe(false);
    expect(guard.authorize(sipRequest({ method: 'CANCEL' }), domain, flow)).toBe(false);
  });

  it('does not establish dialogs from unrelated responses or move ownership', () => {
    const guard = new DialogGuard(); const invite = sipRequest(); const context = guard.context(invite, domain, flow);
    guard.observeResponse(sipResponse(invite));
    guard.observeResponse(sipResponse(invite, 100), context);
    guard.observeResponse(sipResponse(invite), { ...context, requestMethod: 'REGISTER' });
    guard.observeResponse(sipResponse(invite), { ...context, fromTag: 'wrong' });
    guard.observeResponse(sipResponse(invite), { ...context, toTag: 'wrong' });
    expect(guard.authorize(control(), domain, flow)).toBe(false);
    guard.observeResponse(sipResponse(invite), context);
    guard.observeResponse(sipResponse(invite), { ...context, clientFlow: 'tls:attacker' });
    expect(guard.authorize(control(), domain, flow)).toBe(true);
    expect(guard.authorize(control(), domain, 'tls:attacker')).toBe(false);
  });

  it('preserves established calls when an in-dialog re-INVITE fails', () => {
    const guard = new DialogGuard(); established(guard);
    const reinvite = control('INVITE');
    const response = sipResponse(reinvite, 488); response.setHeader('To', reinvite.getFirstHeader('To')!);
    guard.observeResponse(response, guard.context(reinvite, domain, flow));
    expect(guard.authorize(control(), domain, flow)).toBe(true);
  });

  it('bounds pending transactions and dialogs, permits retransmissions and releases expired entries', () => {
    vi.useFakeTimers(); const guard = new DialogGuard(1); const invite = sipRequest();
    expect(guard.trackInvite(invite, domain, flow)).toBe(true);
    expect(guard.trackInvite(invite, domain, flow)).toBe(true);
    expect(guard.trackInvite(sipRequest({ callId: 'second' }), domain, flow)).toBe(false);
    established(guard); const other = sipRequest({ callId: 'other' });
    guard.observeResponse(sipResponse(other), guard.context(other, domain, flow));
    const bye = control(); bye.setHeader('Call-ID', 'other');
    expect(guard.authorize(bye, domain, flow)).toBe(false);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    guard.observeResponse(sipResponse(other), guard.context(other, domain, flow));
    expect(guard.authorize(bye, domain, flow)).toBe(true);
    expect(guard.trackInvite(other, domain, flow)).toBe(true);
  });

  it('tracks subscription dialogs as well as calls', () => {
    const guard = new DialogGuard(); const subscribe = sipRequest({ method: 'SUBSCRIBE' });
    guard.observeResponse(sipResponse(subscribe), guard.context(subscribe, domain, flow));
    expect(guard.authorize(control('NOTIFY'), domain, flow)).toBe(true);
  });
});

describe('SIP identity and routing ambiguity', () => {
  it('uses the actual URI instead of a SIP-looking quoted display name', () => {
    expect(parseSipUri('"sip:victim@trusted.internal" <sip:attacker@evil.internal>'))
      .toEqual({ user: 'attacker', host: 'evil.internal' });
    expect(parseSipUri('"escaped \\" sip:victim@trusted.internal" <sip:alice@pbx.internal>')?.user).toBe('alice');
  });

  it.each(['sip:a@b\u0000', '"unclosed', '<sip:a@b', 'sip:a@b>', 'sip:a@b,sip:c@d',
    '<sip:a@b> junk', '<sip:a@b>;x=<sip:c@d>', '<sip:a b@c>', 'sip:a@b:0', 'sip:a@b:65536',
    'sip:a@b;%broken', 'sip:a@[abcd]', 'sip:a@b\\evil', '"display" sip:a@b'])
    ('rejects malformed or ambiguous address %s', value => expect(parseSipUri(value)).toBeNull());

  it.each([';tag=', ';tag=one;tag=two', ';tag=one/two', ';tag=one garbage', ';tag="one"', ';tag'])
    ('rejects ambiguous dialog tag %s', parameters => {
      expect(readAddressTag(`<sip:a@b>${parameters}`)).toBeNull();
      const request = sipRequest(); request.setHeader('To', `<sip:a@b>${parameters}`);
      expect(request.isValid()).toBe(false);
    });

  it('reads valid tags and untagged addresses and rejects an invalid address', () => {
    expect(readAddressTag('<sip:a@b>;tag=valid-123')).toBe('valid-123');
    expect(readAddressTag('sip:a@b;tag=valid-123')).toBe('valid-123');
    expect(readAddressTag('bad')).toBeNull();
    expect(readAddressTag('<sip:a@b>')).toBeUndefined();
    expect(splitNameAddress('<sip:a@b>')).toEqual({ uri: 'sip:a@b', parameters: '' });
  });

  it('rejects control characters and multiple top Via branches', () => {
    const raw = sipRequest().toString().replace('Call-ID: test-call', 'Call-ID: test\u0001call');
    expect(new SipMessage(raw).isValid()).toBe(false);
    const request = sipRequest(); request.setHeader('Via', 'SIP/2.0/UDP phone;branch=one;branch=two');
    expect(request.isValid()).toBe(false);
    expect(request.getBranchFromVia('SIP/2.0/UDP phone, SIP/2.0/UDP attacker;branch=spoof')).toBeUndefined();
  });

  it('rejects client routing injection and permits only a single relay loose Route', () => {
    const request = sipRequest(); expect(request.hasUnsafeRouting('relay')).toBe(false);
    request.setHeader('Record-Route', '<sip:attacker;lr>');
    expect(request.hasUnsafeRouting('relay')).toBe(true);
    expect(request.hasUnsafeRouting('relay', true)).toBe(false); request.removeHeader('Record-Route');
    for (const routes of [['<sip:attacker;lr>'], ['<sip:relay>'], ['<sip:relay;lr>', '<sip:attacker;lr>'],
      ['<sip:relay;lr>, <sip:attacker;lr>']]) {
      request.setHeader('Route', routes); expect(request.hasUnsafeRouting('relay')).toBe(true);
    }
    request.setHeader('Route', '<sip:relay;lr;sr-domain=pbx.internal>');
    expect(request.hasUnsafeRouting('relay')).toBe(false);
  });

  it('keeps REGISTER target, AoR and rewritten Contact on the same account', () => {
    const register = sipRequest({ method: 'REGISTER', target: 'pbx.internal' });
    expect(register.hasSafeRegistration()).toBe(true);
    register.setHeader('Contact', '<sip:victim@phone>'); expect(register.hasSafeRegistration()).toBe(false);
    register.setHeader('Contact', ['<sip:alice@phone>', '<sip:alice@other>']); expect(register.hasSafeRegistration()).toBe(false);
    register.setHeader('Contact', '*'); expect(register.hasSafeRegistration()).toBe(false);
    register.setHeader('Expires', '0'); expect(register.hasSafeRegistration()).toBe(true);
    register.removeHeader('Contact'); expect(register.hasSafeRegistration()).toBe(true);
    register.setHeader('To', '<sip:alice@another.internal>'); expect(register.hasSafeRegistration()).toBe(false);
    register.setHeader('To', '<sip:pbx.internal>'); expect(register.hasSafeRegistration()).toBe(false);
  });

  it('does not let a PBX claim another known tenant or guess an ambiguous shared endpoint', () => {
    const records = new MemoryStore(); records.addRecord(domain, { ip: '10.0.0.1', udpPort: 5060, tlsPort: 5061 });
    records.addRecord('other.internal', { ip: '10.0.0.2', udpPort: 5060, tlsPort: 5061 });
    const resolver = new PbxRouteResolver(records);
    expect(resolver.resolveUdp(sipRequest(), { address: '10.0.0.2', port: 5060 })).toBeUndefined();
    expect(resolver.resolveTls(sipRequest(), '10.0.0.2:5061')).toBeUndefined();
    records.addRecord('shared.internal', { ip: '10.0.0.1', udpPort: 5060 });
    const external = sipRequest({ domain: 'external' });
    expect(resolver.resolveUdp(external, { address: '10.0.0.1', port: 5060 })).toBeUndefined();
  });
});

describe('resource and response trust boundaries', () => {
  it('bounds per-peer and global parsing work and resets budgets each second', () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const limiter = new IngressLimiter(3, 2);
    expect(limiter.allow('a')).toBe(true); expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false); expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('c')).toBe(false); vi.advanceTimersByTime(1000);
    expect(limiter.allow('a')).toBe(true); expect(limiter.allow('c')).toBe(true);
  });

  it('fails closed if expected response socket or upstream metadata is missing', () => {
    const validator = new SipResponseValidator(createTestLogger()); const message = sipResponse(sipRequest());
    expect(validator.validate({ sipMessage: message, callId: 'test-call', expectedUpstreamKey: 'pbx' }).ok).toBe(false);
    expect(validator.validate({ sipMessage: message, callId: 'test-call', expectedSocket: new FakeTlsSocket().asSocket() }).ok).toBe(false);
    expect(validator.validate({ sipMessage: message, callId: 'test-call', expectedFromTag: 'wrong' }).ok).toBe(false);
    expect(validator.validate({ sipMessage: message, callId: 'test-call', expectedFromTag: 'caller', expectedToTag: 'wrong' }).ok).toBe(false);
    expect(validator.validate({ sipMessage: message, callId: 'test-call', expectedFromTag: 'caller', expectedToTag: 'callee' }).ok).toBe(true);
  });
});

describe('Contact rewrite identity preservation', () => {
  it('rewrites the actual Contact authority and preserves a misleading display name', () => {
    const message = sipRequest({ method: 'REGISTER' });
    message.setHeader('Contact', '"sip:victim@elsewhere" <sip:alice@phone;transport=tls>;expires=60');
    expect(message.hasSafeRegistration()).toBe(true);
    message.updateContact('relay', 5061);
    expect(message.getFirstHeader('Contact')).toBe('"sip:victim@elsewhere" <sip:alice@relay:5061;transport=tls>;expires=60');
    const incoming = sipRequest();
    incoming.useClientContact('"<sip:victim@elsewhere>" <sip:alice@phone;pn-provider=fcm;pn-prid=secret>');
    expect(incoming.startLine).toBe('INVITE sip:alice@phone SIP/2.0');
  });

  it('handles a bare URI and ignores malformed Contacts without changing the destination', () => {
    const message = sipRequest(); message.setHeader('Contact', 'sip:alice@phone;transport=udp');
    message.updateContact('relay', 5060);
    expect(message.getFirstHeader('Contact')).toBe('sip:alice@relay:5060;transport=udp');
    message.setHeader('Contact', '*'); message.updateContact('relay', 5060);
    expect(message.getFirstHeader('Contact')).toBe('*');
    const original = message.startLine; message.useClientContact('<invalid'); expect(message.startLine).toBe(original);
  });

  it('rejects controls hidden in a folded header continuation', () => {
    const raw = sipRequest().toString().replace('Call-ID: test-call', 'Call-ID: test-call\r\n\tbad\u0001value');
    expect(new SipMessage(raw).isValid()).toBe(false);
  });
});


it('selects push metadata from the actual Contact URI', () => {
  expect(parsePushDestination('"<sip:x@y;pn-provider=fcm;pn-param=evil;pn-prid=evil>" <sip:alice@phone;pn-provider=fcm;pn-param=project;pn-prid=real>'))
    .toEqual({ provider: 'fcm', app: 'project', token: 'real' });
  expect(parsePushDestination('<invalid')).toBeUndefined();
});

it('handles absent optional SIP fields and a comma-separated top Via safely', () => {
  const empty = new SipMessage('');
  expect(empty.getStatusCode()).toBeUndefined(); expect(empty.getCSeqMethod()).toBeUndefined();
  expect(empty.getTargetUser()).toBeNull(); empty.setReceived('phone', 5090); empty.replaceViaTop('ignored');
  empty.removeViaTop(); empty.updateContact('relay', 5060);
  const request = sipRequest();
  request.setHeader('Via', 'SIP/2.0/UDP relay;branch=one, SIP/2.0/UDP phone;branch=two');
  request.removeViaTop(); expect(request.getTopVia()).toBe('SIP/2.0/UDP phone;branch=two');
  request.useClientContact('<tel:123>'); expect(request.getTargetHost()).toBe('pbx.internal');
  expect(empty.getAddressOfRecord()).toBeNull();
  const tabbed = sipRequest().toString().replace('Max-Forwards: 70', 'Max-Forwards: 7\t0');
  expect(new SipMessage(tabbed).decrementMaxForwards()).toBe(false);
});

it('removes the relay Via entirely when it is the only remaining hop', () => {
  const response = sipResponse(sipRequest()); response.removeViaTop();
  expect(response.getHeader('Via')).toEqual([]);
  expect(response.toString()).not.toContain('Via:');
});

it('does not take routing parameters from display names or SIP URI query fields', () => {
  const request = sipRequest(); request.setHeader('Route', '";lr;sr-domain=pbx.internal;" <sip:relay>');
  expect(request.hasUnsafeRouting('relay')).toBe(true); expect(request.takeProxyRoute('relay')).toBeUndefined();
  request.setHeader('Route', '<sip:relay;lr?Route=evil>'); expect(request.hasUnsafeRouting('relay')).toBe(true);
});
