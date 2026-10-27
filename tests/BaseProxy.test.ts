import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseProxy } from '../src/proxies/BaseProxy';
import { MemoryStore, RegistrationStore } from '../src/store';
import { SipMessage } from '../src/sip';
import { createTestLogger } from './utils';
import { sipRequest, sipResponse } from './fixtures/sip';
import { FakeTlsSocket } from './fixtures/transports';

class ProxyHarness extends BaseProxy {
  start(): void {}
  branch = this.createProxyBranch.bind(this);
  flow = this.tlsFlow.bind(this);
  fillTransactions(): void {
    for (let i = 0; i < 10_000; i++) this.clientMap.set(String(i), { address: 'phone', port: 5090 });
  }
  remember = this.storeClient.bind(this);
  lookup = this.getClient.bind(this);
  forget = this.removeClient.bind(this);
  route = this.getTargetRecord.bind(this);
  forwardHeaders = this.addProxyHeaders.bind(this);
  responseHeaders = this.prepareSipResponseForClient.bind(this);
}
const fixture = () => new ProxyHarness(new MemoryStore(), createTestLogger(), new RegistrationStore());
afterEach(() => { vi.useRealTimers(); });

describe('proxy transaction lifetimes and forwarding headers', () => {
  it('expires at the idle boundary and refreshes lifetime when a transaction is used', () => {
    vi.useFakeTimers(); const proxy = fixture();
    proxy.remember('call', '192.0.2.1', 5090);
    vi.advanceTimersByTime(179_999); expect(proxy.lookup('call')).toBeDefined();
    vi.advanceTimersByTime(179_999); expect(proxy.lookup('call')).toBeDefined();
    vi.advanceTimersByTime(180_000); expect(proxy.lookup('call')).toBeUndefined();
  });

  it('clears an old timer when retransmissions replace a transaction mapping', () => {
    vi.useFakeTimers(); const proxy = fixture();
    proxy.remember('call', '192.0.2.1', 5090, { proxyBranch: 'branch', upstreamKey: 'upstream' });
    vi.advanceTimersByTime(100_000);
    proxy.remember('call', '192.0.2.2', 5099);
    vi.advanceTimersByTime(80_000);
    expect(proxy.lookup('call')).toMatchObject({ address: '192.0.2.2', port: 5099, proxyBranch: 'branch', upstreamKey: 'upstream' });
    expect(vi.getTimerCount()).toBe(1);
    proxy.forget('call'); proxy.forget('unknown');
    expect(proxy.lookup('call')).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an originating TLS socket during a mapping refresh', () => {
    vi.useFakeTimers(); const proxy = fixture(); const socket = new FakeTlsSocket().asSocket();
    proxy.remember('call', '192.0.2.1', 5090, { transportSocket: socket });
    proxy.remember('call', '192.0.2.1', 5090);
    expect(proxy.lookup('call')?.socket).toBe(socket); proxy.forget('call');
  });

  it('adds a relay Via and REGISTER Contact, brackets IPv6, and preserves SDP', () => {
    const proxy = fixture(); const request = sipRequest({ method: 'REGISTER', body: 'v=0\r\nc=IN IP4 192.0.2.1\r\n' });
    const body = request.body;
    const branch = proxy.forwardHeaders(request, 'TLS', '2001:db8::1', 5061, 'pbx.internal');
    expect(request.getTopVia()).toBe(`SIP/2.0/TLS [2001:db8::1]:5061;branch=${branch}`);
    expect(request.getFirstHeader('Contact')).toContain('@[2001:db8::1]:5061');
    expect(request.body).toBe(body);
    const response = sipResponse(request); proxy.responseHeaders(response);
    expect(response.getHeader('Via')).toHaveLength(1);
    expect(response.getTopVia()).toContain('z9hG4bK-phone');
  });

  it('retains dialog Contacts and adds Record-Route to initial INVITEs', () => {
    const proxy = fixture(); const request = sipRequest(); const contact = request.getFirstHeader('Contact');
    proxy.forwardHeaders(request, 'UDP', 'relay.example', 5060, 'pbx.internal');
    expect(request.getFirstHeader('Contact')).toBe(contact);
    expect(request.getFirstHeader('Record-Route')).toContain(';sr-domain=pbx.internal');
    expect(proxy.route('unknown')).toBeNull();
    proxy.responseHeaders(new SipMessage('SIP/2.0 200 OK\r\n\r\n'));
  });
});


describe('unguessable transaction branches', () => {
  it('binds retransmissions to the tenant and connection using a per-process secret', () => {
    const proxy = fixture(), message = sipRequest();
    const branch = proxy.branch(message, 'PBX.INTERNAL', 'phone');
    expect(branch).toBe(proxy.branch(message, 'pbx.internal', 'phone'));
    expect(branch).not.toBe(message.generateBranch());
    expect(branch).not.toBe(proxy.branch(message, 'other.internal', 'phone'));
    expect(branch).not.toBe(proxy.branch(message, 'pbx.internal', 'attacker'));
    expect(branch).not.toBe(fixture().branch(message, 'pbx.internal', 'phone'));
    expect(branch).toBe(proxy.branch(sipRequest({ method: 'CANCEL' }), 'pbx.internal', 'phone'));
    const first = new FakeTlsSocket().asSocket(), second = new FakeTlsSocket().asSocket();
    expect(proxy.flow(first)).toBe(proxy.flow(first));
    expect(proxy.flow(first)).not.toBe(proxy.flow(second));
  });

  it('limits transaction memory while preserving a valid retransmission at capacity', () => {
    const proxy = fixture(); proxy.fillTransactions();
    expect(proxy.remember('overflow', 'attacker', 5090)).toBe(false);
    expect(proxy.remember('0', 'phone', 5090)).toBe(true);
    proxy.forget('0');
  });

  it('does not let an unvalidated response prolong transaction lifetime', () => {
    vi.useFakeTimers(); const proxy = fixture(); proxy.remember('call', 'phone', 5090);
    vi.advanceTimersByTime(179_000); expect(proxy.lookup('call', false)).toBeDefined();
    vi.advanceTimersByTime(1_000); expect(proxy.lookup('call', false)).toBeUndefined();
  });
});
