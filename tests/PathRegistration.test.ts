import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UdpProxy } from '../src/proxies/UdpProxy';
import { MemoryStore, RegistrationStore } from '../src/store';
import { SipMessage } from '../src/sip';
import { RegistrationService } from '../src/sip/RegistrationService';
import { FlowTokenCodec } from '../src/security/FlowTokenCodec';
import { splitSipList } from '../src/sip/SipList';
import { parseSipUri } from '../src/sip/SipUri';
import { Config } from '../src/configurations';
import { createTestConfig, createTestLogger } from './utils';
import { sipRequest, sipResponse } from './fixtures/sip';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllEnvs(); vi.useRealTimers(); });
class Socket extends EventEmitter { bind = vi.fn((_port: number, callback: () => void) => callback()); send = vi.fn((_bytes: Buffer, _port: number, _ip: string) => {}); }
function fixture() {
  const records = new MemoryStore(); records.addRecord('pbx.internal', { ip: '10.0.0.50', udpPort: 5060 });
  const registrations = new RegistrationStore(), socket = new Socket();
  const proxy = new UdpProxy(records, createTestConfig({ SIP_REGISTRATION_MODE: 'path' }), createTestLogger(), registrations, { socket });
  proxy.start(); cleanups.push(() => proxy.disposeTransactions());
  const phone = { address: '198.51.100.10', port: 5090 }, pbx = { address: '10.0.0.50', port: 5060 };
  const emit = (message: SipMessage, peer = phone) => socket.emit('message', message.toBuffer(), peer);
  const register = sipRequest({ method: 'REGISTER' }); register.setHeader('Supported', 'path'); register.setHeader('Contact', '<sip:device-opaque@192.168.1.2:5070>');
  emit(register); const outgoing = new SipMessage(socket.send.mock.calls[0][0]);
  const response = sipResponse(outgoing); response.setHeader('Contact', '<sip:device-opaque@192.168.1.2:5070>;expires=600'); emit(response, pbx);
  const path = outgoing.getFirstHeader('Path')!; socket.send.mockClear();
  return { proxy, records, registrations, socket, phone, pbx, emit, path, outgoing };
}

describe('Path-based registration and authenticated routing', () => {
  it('preserves the Contact and delivers an arbitrary Contact username over its authenticated Path', () => {
    const f = fixture(); expect(f.outgoing.getFirstHeader('Contact')).toBe('<sip:device-opaque@192.168.1.2:5070>');
    expect(f.path).toContain(';lr;sr-domain=pbx.internal'); expect(parseSipUri(f.path)?.user).toMatch(/^ft\./);
    expect(f.registrations.get('pbx.internal', 'alice')?.flowToken).toBeDefined();
    const incoming = sipRequest({ target: 'device-opaque@192.168.1.2:5070', callId: 'incoming' }); incoming.setHeader('Route', f.path); f.emit(incoming, f.pbx);
    const forwarded = new SipMessage(f.socket.send.mock.calls[0][0]); expect(forwarded.startLine).toBe(incoming.startLine);
    expect(forwarded.getFirstHeader('Record-Route')).toContain('ft.'); expect(f.socket.send.mock.calls[0].slice(1)).toEqual([f.phone.port, f.phone.address]);
  });
  it('rejects forged tokens and returns Flow Failed for a valid but expired route', () => {
    vi.useFakeTimers(); const f = fixture(); const request = sipRequest({ target: 'device-opaque@192.168.1.2:5070' });
    request.setHeader('Route', f.path.replace('ft.', 'ft.bad')); f.emit(request, f.pbx);
    expect(f.socket.send.mock.calls[0][0].toString()).toContain('403 Forbidden');
    f.registrations.remove('pbx.internal', 'alice'); const stale = sipRequest({ target: 'device-opaque@192.168.1.2:5070', callId: 'stale' }); stale.setHeader('Route', f.path); f.emit(stale, f.pbx);
    expect(f.socket.send.mock.calls[1][0].toString()).toContain('430 Flow Failed');
  });
  it('does not allow another phone flow to use a token assigned to the registered phone', () => {
    const f = fixture(); const request = sipRequest({ callId: 'stolen-token' }); request.setHeader('Route', f.path);
    f.emit(request, { address: '198.51.100.99', port: 6000 });
    expect(f.socket.send.mock.calls[0][0].toString()).toContain('403 Forbidden');
    expect(f.socket.send.mock.calls[0][2]).toBe('198.51.100.99');
  });
  it('places the authenticated device flow in outgoing Record-Route', () => {
    const f = fixture(); f.emit(sipRequest({ callId: 'outgoing-call' }));
    expect(new SipMessage(f.socket.send.mock.calls[0][0]).getFirstHeader('Record-Route')).toContain('ft.');
  });
});

describe('multiple Contact bindings', () => {
  it('accepts multiple Contacts in Path mode and independently applies registrar lifetimes/removals', () => {
    const store = new RegistrationStore(), service = new RegistrationService(store, createTestLogger(), 1000, 'path');
    const request = sipRequest({ method: 'REGISTER' }); request.setHeader('Contact', ['<sip:first@phone>;expires=600', '<sip:second@phone>;expires=300']);
    expect(request.hasSafeRegistration('path')).toBe(true); expect(request.hasSafeRegistration()).toBe(false);
    const token = store.createFlowToken({ domain: 'pbx.internal', user: 'alice', flow: 'udp:phone' });
    service.trackRequest(request, { address: 'phone', port: 5090, flowToken: token });
    const forwarded = request.clone(); forwarded.addViaTop(`SIP/2.0/UDP relay;branch=${request.generateBranch()}`);
    const response = sipResponse(forwarded); response.setHeader('Contact', '<sip:first@phone>;expires=120, <sip:second@phone>;expires=60'); service.handleResponse(response);
    expect(store.getAll('pbx.internal', 'alice')).toHaveLength(2); expect(store.getByFlowToken(token)).toBeDefined();
    const remove = sipRequest({ method: 'REGISTER', cseq: 2 }); remove.setHeader('Contact', '<sip:first@phone>;expires=0');
    service.trackRequest(remove, { address: 'phone', port: 5090 }); const sent = remove.clone(); sent.addViaTop(`SIP/2.0/UDP relay;branch=${remove.generateBranch()}`);
    const accepted = sipResponse(sent); accepted.setHeader('Contact', '<sip:second@phone>;expires=60'); service.handleResponse(accepted);
    expect(store.getAll('pbx.internal', 'alice').map(binding => binding.id)).toEqual(['sip:second@phone']);
  });
  it('does not invent accepted bindings or accept invalid lifetimes', () => {
    const store = new RegistrationStore(), service = new RegistrationService(store, createTestLogger(), 1000, 'path');
    for (const expiry of [undefined, '4294967296', '-1']) {
      const request = sipRequest({ method: 'REGISTER', callId: `expiry-${expiry}` }); service.trackRequest(request, { address: 'phone', port: 5090 });
      const forwarded = request.clone(); forwarded.addViaTop(`SIP/2.0/UDP relay;branch=${request.generateBranch()}`);
      const response = sipResponse(forwarded); response.setHeader('Contact', `${request.getContactHeaders()[0]}${expiry ? `;expires=${expiry}` : ''}`); service.handleResponse(response);
    }
    expect(store.getAll('pbx.internal', 'alice')).toEqual([]);
  });
  it('parses quoted commas and rejects malformed header lists', () => {
    expect(splitSipList('"Last, First" <sip:a@phone>, <sip:b@phone>')).toEqual(['"Last, First" <sip:a@phone>', '<sip:b@phone>']);
    expect(splitSipList('"escaped \\" comma," <sip:a@phone>')).toHaveLength(1);
    for (const invalid of ['<sip:a@phone', '<sip:a@phone>>', '<<sip:a@phone>>', '"unclosed', '<sip:a@phone>,']) expect(splitSipList(invalid)).toBeUndefined();
  });
});

it('authenticates flow-token content, scope and process lifetime', () => {
  const codec = new FlowTokenCodec(), other = new FlowTokenCodec(); const identity = { domain: 'PBX.INTERNAL', user: 'alice', flow: 'socket-1' };
  const token = codec.encode(identity); expect(codec.decode(token)).toEqual({ ...identity, domain: 'pbx.internal' });
  expect(other.decode(token)).toBeUndefined(); expect(codec.decode(token.slice(0, -2))).toBeUndefined();
  expect(codec.decode('invalid')).toBeUndefined(); expect(codec.decode('x'.repeat(2049))).toBeUndefined();
  expect(codec.decode(codec.encode({ ...identity, user: '' }))).toBeUndefined();
});

it('defaults to Path registration, with an explicit validated legacy switch', () => {
  vi.stubEnv('SIP_REGISTRATION_MODE', 'path'); expect(new Config().SIP_REGISTRATION_MODE).toBe('path');
  vi.stubEnv('SIP_REGISTRATION_MODE', 'contact'); expect(new Config().SIP_REGISTRATION_MODE).toBe('contact');
  vi.stubEnv('SIP_REGISTRATION_MODE', 'other'); expect(() => new Config()).toThrow('SIP_REGISTRATION_MODE');
});

it('requires Path negotiation rather than silently rewriting an unsupported UA', async () => {
  const { checkProxyRequest } = await import('../src/sip/ProxyRequestPolicy'); const request = sipRequest({ method: 'REGISTER' });
  expect(checkProxyRequest(request, 'TLS', 'path')).toEqual({ status: 421, reason: 'Extension Required', headers: { Require: 'path' } });
  request.setHeader('Supported', 'outbound, PATH'); expect(checkProxyRequest(request, 'TLS', 'path')).toBeUndefined();
  request.addRegistrationPath('token', 'pbx.internal', 'relay', 5061, 'TLS');
  expect(request.getHeader('Require')).toEqual(['path']);
  request.addRegistrationPath('token2', 'pbx.internal', 'relay', 5061, 'TLS'); expect(request.getHeader('Require')).toEqual(['path']);
});

it('does not match expired, foreign, malformed or removed flow bindings', () => {
  const store = new RegistrationStore();
  const identity = { domain: 'pbx.internal', user: 'alice', flow: 'udp:phone' };
  const token = store.createFlowToken(identity);
  const binding = { ...identity, clientAddress: 'phone', clientPort: 5060, expiresAt: Date.now() + 60_000, id: 'device', flowToken: token };
  expect(store.getByFlowToken('invalid')).toBeUndefined();
  expect(store.remove('pbx.internal', 'alice', 'absent')).toBe(false);
  store.upsert({ ...binding, flowToken: 'invalid' });
  expect(store.getByFlowToken(token)).toBeUndefined();
  expect(store.getFlowToken('pbx.internal', identity.flow)).toBeUndefined();
  store.upsert(binding);
  expect(store.getFlowToken('another.internal', identity.flow)).toBeUndefined();
  expect(store.getFlowToken('pbx.internal', 'other-flow')).toBeUndefined();
  store.upsert({ ...binding, expiresAt: Date.now() - 1 });
  expect(store.getAll('pbx.internal', 'alice')).toEqual([]);
  expect(store.getByFlowToken(token)).toBeUndefined();
});

it('forwards registration queries and wildcard removal without negotiating a new Path', () => {
  const f = fixture();
  const query = sipRequest({ method: 'REGISTER', callId: 'query' }); query.removeHeader('Contact');
  f.emit(query);
  const outgoingQuery = new SipMessage(f.socket.send.mock.calls[0][0]);
  expect(outgoingQuery.getHeader('Path')).toEqual([]); expect(outgoingQuery.getHeader('Require')).toEqual([]);
  const remove = sipRequest({ method: 'REGISTER', callId: 'remove' }); remove.setHeader('Contact', '*'); remove.setHeader('Expires', '0');
  f.emit(remove);
  const outgoingRemove = new SipMessage(f.socket.send.mock.calls[1][0]);
  expect(outgoingRemove.getHeader('Path')).toEqual([]); expect(outgoingRemove.getHeader('Require')).toEqual([]);
});

it.each(['separate', 'combined'])('delivers Asterisk BYE with identical Path and dialog Route entries (%s)', form => {
  const f = fixture();
  const bye = sipRequest({ method: 'BYE', target: 'device-opaque@192.168.1.2:5070', callId: `bye-${form}` });
  bye.setHeader('To', '<sip:alice@pbx.internal>;tag=phone');
  bye.setHeader('Route', form === 'combined' ? `${f.path}, ${f.path}` : [f.path, f.path]);
  f.emit(bye, f.pbx);
  expect(f.socket.send).toHaveBeenCalledOnce();
  const delivered = new SipMessage(f.socket.send.mock.calls[0][0]);
  expect(delivered.getMethod()).toBe('BYE'); expect(delivered.getHeader('Route')).toEqual([]);
  expect(f.socket.send.mock.calls[0].slice(1)).toEqual([f.phone.port, f.phone.address]);
});

it('rejects repeated routes that change the flow token or tenant', () => {
  const f = fixture(); const request = sipRequest();
  request.setHeader('Route', [f.path, f.path.replace('ft.', 'ft.other')]);
  expect(request.hasUnsafeRouting('203.0.113.5', true)).toBe(true);
  request.setHeader('Route', [f.path, f.path.replace('pbx.internal', 'foreign.internal')]);
  expect(request.hasUnsafeRouting('203.0.113.5', true)).toBe(true);
});
