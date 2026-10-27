import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogGuard } from '../src/security/DialogGuard';
import { BaseProxy } from '../src/proxies/BaseProxy';
import { UdpProxy } from '../src/proxies/UdpProxy';
import { MemoryStore, RegistrationBinding, RegistrationStore } from '../src/store';
import { SipMessage } from '../src/sip';
import { PushCoordinator } from '../src/push/PushCoordinator';
import { createTestConfig, createTestLogger } from './utils';
import { flushAsync, sipRequest, sipResponse } from './fixtures/sip';

class UdpSocket extends EventEmitter {
  bind = vi.fn((_port: number, callback: () => void) => { callback(); });
  send = vi.fn((_payload: Buffer, _port: number, _address: string) => {});
}
const phone = { address: '198.51.100.10', port: 5090 };
const pbx = { address: '10.0.0.50', port: 5060 };
const cleanups: Array<() => void> = [];
function fixture() {
  const socket = new UdpSocket(); const records = new MemoryStore(); const registrations = new RegistrationStore();
  records.addRecord('pbx.internal', { ip: pbx.address, udpPort: pbx.port });
  const logger = createTestLogger(); const sender = { supports: () => true, send: vi.fn().mockResolvedValue(undefined) };
  const coordinator = new PushCoordinator(registrations, sender, logger);
  const proxy = new UdpProxy(records, createTestConfig(), logger, registrations, { socket, pushCoordinator: coordinator });
  proxy.start(); cleanups.push(() => coordinator.dispose());
  const emit = (message: SipMessage, peer = phone) => socket.emit('message', Buffer.from(message.toString()), peer);
  return { proxy, socket, records, registrations, logger, sender, emit };
}
function binding(push = false): RegistrationBinding {
  return { domain: 'pbx.internal', user: 'alice', clientAddress: phone.address, clientPort: phone.port,
    transport: 'UDP', expiresAt: Date.now() + 60000,
    ...(push ? { push: { provider: 'fcm' as const, app: 'project', token: 'secret' } } : {}) };
}
const incoming = (method = 'INVITE') => sipRequest({ method, target: 'alice@203.0.113.5' });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('UDP ingress and spoofed responses', () => {
  it('logs socket errors and binds to the configured port', () => {
    const { socket, logger } = fixture(); expect(socket.bind).toHaveBeenCalledWith(15060, expect.any(Function));
    socket.emit('error', new Error('UDP failure')); expect(logger.error).toHaveBeenCalledWith('SIP UDP socket error', expect.any(Error));
  });

  it('rejects wrong source endpoints, branches and unknown transactions before accepting the real response', () => {
    const { socket, emit } = fixture(); emit(sipRequest());
    const response = sipResponse(new SipMessage(socket.send.mock.calls[0][0].toString())); socket.send.mockClear();
    emit(response, { ...pbx, port: 55000 }); emit(response, { ...pbx, address: '203.0.113.99' });
    const wrong = new SipMessage(response.toString()); wrong.setHeader('Via', 'SIP/2.0/UDP relay;branch=wrong'); emit(wrong, pbx);
    wrong.setHeader('Call-ID', 'unknown'); emit(wrong, pbx);
    expect(socket.send).not.toHaveBeenCalled();
    emit(response, pbx); expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls[0].slice(1)).toEqual([phone.port, phone.address]);
    expect(new SipMessage(socket.send.mock.calls[0][0].toString()).getHeader('Via')).toHaveLength(1);
  });

  it('does not route unknown domains, unsupported URI schemes, or PBXs without UDP', () => {
    const { socket, records, emit } = fixture();
    emit(sipRequest({ target: 'alice@unknown' }));
    const star = sipRequest({ method: 'OPTIONS' }); star.startLine = 'OPTIONS * SIP/2.0'; emit(star);
    records.addRecord('tls-only.internal', { ip: '10.0.0.2', tlsPort: 5061 });
    emit(sipRequest({ target: 'alice@tls-only.internal' })); expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.send.mock.calls[0][0].toString()).toContain('416 Unsupported URI Scheme');
  });

  it('does not send local error responses to ACK', () => {
    const { socket, emit } = fixture(); const ack = sipRequest({ method: 'ACK' }); ack.setHeader('Max-Forwards', '0');
    emit(ack); expect(socket.send).not.toHaveBeenCalled();
  });
});

describe('PBX delivery isolation', () => {
  it('requires a trusted PBX endpoint, an existing user and a matching transport', () => {
    const { socket, emit, registrations } = fixture(); registrations.upsert(binding());
    emit(incoming(), { address: '203.0.113.99', port: 5060 });
    emit(incoming(), { ...pbx, port: 55000 });
    emit(sipRequest({ target: '203.0.113.5' }), pbx);
    emit(sipRequest({ target: 'unknown@203.0.113.5' }), pbx);
    registrations.upsert({ ...binding(), transport: 'TLS' }); const tcpOnly = incoming(); tcpOnly.setHeader('Call-ID', 'wrong-transport'); emit(tcpOnly, pbx);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('purges expired devices and never delivers to their stale NAT endpoint', () => {
    const { socket, emit, registrations } = fixture(); registrations.upsert({ ...binding(), expiresAt: Date.now() - 1 });
    emit(incoming(), pbx); expect(socket.send).not.toHaveBeenCalled();
  });

  it('restores the device Contact and returns its response to the originating PBX', () => {
    const { socket, emit, registrations } = fixture();
    registrations.upsert({ ...binding(), clientContact: '<sip:alice@192.168.1.10:5060;transport=udp>' });
    emit(incoming(), pbx);
    const forwarded = new SipMessage(socket.send.mock.calls[0][0].toString());
    expect(forwarded.startLine).toBe('INVITE sip:alice@192.168.1.10:5060;transport=udp SIP/2.0');
    socket.send.mockClear(); emit(sipResponse(forwarded), phone);
    expect(socket.send.mock.calls[0].slice(1)).toEqual([pbx.port, pbx.address]);
  });
});

describe('UDP pending mobile calls', () => {
  it('deduplicates incoming retransmissions, cancels waiting calls, and absorbs their ACK', async () => {
    const { socket, emit, registrations, sender } = fixture(); registrations.upsert(binding(true));
    emit(incoming(), pbx); emit(incoming(), pbx); expect(sender.send).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls.every(call => call[0].toString().includes('100 Trying'))).toBe(true);
    socket.send.mockClear(); emit(incoming('CANCEL'), pbx);
    expect(socket.send.mock.calls.map(call => new SipMessage(call[0].toString()).getStatusCode())).toEqual([200, 487]);
    const count = socket.send.mock.calls.length;
    const ack = incoming('ACK'); ack.setHeader('To', new SipMessage(socket.send.mock.calls[1][0]).getFirstHeader('To')!);
    emit(ack, pbx); registrations.upsert({ ...binding(true), clientPort: 55000 }); await flushAsync();
    expect(socket.send).toHaveBeenCalledTimes(count);
  });

  it('returns 480 when no refreshed registration arrives', () => {
    vi.useFakeTimers(); const { socket, emit, registrations } = fixture(); registrations.upsert(binding(true));
    emit(incoming(), pbx); vi.advanceTimersByTime(25000);
    expect(socket.send.mock.calls.at(-1)![0].toString()).toContain('480 Temporarily Unavailable');
    expect(socket.send.mock.calls.every(call => call[2] === pbx.address)).toBe(true);
  });

  it('does not push for an in-dialog re-INVITE', () => {
    const { socket, emit, registrations, sender } = fixture(); registrations.upsert(binding(true));
    const reinvite = incoming(); reinvite.setHeader('To', '<sip:alice@pbx.internal>;tag=callee'); emit(reinvite, pbx);
    expect(sender.send).not.toHaveBeenCalled(); expect(socket.send.mock.calls[0][2]).toBe(phone.address);
  });
});

describe('UDP call hijack regressions', () => {
  it('rejects forged call controls while allowing the original phone to end its established call', () => {
    const { socket, emit } = fixture(); emit(sipRequest());
    const forwarded = new SipMessage(socket.send.mock.calls[0][0].toString());
    emit(sipResponse(forwarded), pbx); socket.send.mockClear();
    const bye = sipRequest({ method: 'BYE', cseq: 2 }); bye.setHeader('To', '<sip:alice@pbx.internal>;tag=callee');
    emit(bye, { address: '198.51.100.99', port: 5090 });
    expect(socket.send.mock.calls[0][0].toString()).toContain('481 Call/Transaction Does Not Exist');
    expect(socket.send.mock.calls[0][2]).toBe('198.51.100.99'); socket.send.mockClear();
    emit(bye); expect(socket.send.mock.calls[0].slice(1)).toEqual([pbx.port, pbx.address]);
  });

  it('rejects unknown ACK, unsafe REGISTER and client Route injection', () => {
    const { socket, emit } = fixture(); emit(sipRequest({ method: 'ACK' }));
    const injection = sipRequest(); injection.setHeader('Route', '<sip:attacker;lr>'); emit(injection);
    expect(socket.send).not.toHaveBeenCalled();
    const register = sipRequest({ method: 'REGISTER' }); register.setHeader('Contact', '<sip:victim@phone>'); emit(register);
    expect(socket.send).toHaveBeenCalledOnce(); expect(socket.send.mock.calls[0][0].toString()).toContain('400 Bad Request');
  });

  it('drops excessive datagrams and limits per-source parsing work', () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const { socket, emit } = fixture();
    socket.emit('message', Buffer.alloc(65537), phone);
    for (let i = 0; i < 201; i++) emit(sipRequest({ method: 'OPTIONS', callId: `limit-${i}` }));
    expect(socket.send).toHaveBeenCalledTimes(200);
  });
});


it('fails closed when INVITE or transaction capacity is exhausted', () => {
  const { socket, emit, registrations } = fixture();
  const inviteCapacity = vi.spyOn(DialogGuard.prototype, 'trackInvite').mockReturnValue(false);
  emit(sipRequest()); expect(socket.send).not.toHaveBeenCalled(); inviteCapacity.mockRestore();
  vi.spyOn(BaseProxy.prototype as unknown as { storeClient: () => boolean }, 'storeClient').mockReturnValue(false);
  emit(sipRequest()); expect(socket.send).not.toHaveBeenCalled();
  registrations.upsert(binding()); emit(incoming(), pbx); expect(socket.send).not.toHaveBeenCalled();
});

it('rejects unsupported proxy extensions and SIPS on UDP, but sends no response to invalid ACK', () => {
  const { socket, emit } = fixture(); const extension = sipRequest(); extension.setHeader('Proxy-Require', 'outbound'); emit(extension);
  expect(socket.send.mock.calls[0][0].toString()).toContain('420 Bad Extension');
  expect(socket.send.mock.calls[0][0].toString()).toContain('Unsupported: outbound');
  const secure = sipRequest({ callId: 'secure-call' }); secure.startLine = 'INVITE sips:alice@pbx.internal SIP/2.0'; emit(secure);
  expect(socket.send.mock.calls[1][0].toString()).toContain('416 Unsupported URI Scheme');
  const ack = sipRequest({ method: 'ACK' }); ack.startLine = 'ACK sips:alice@pbx.internal SIP/2.0'; emit(ack);
  expect(socket.send).toHaveBeenCalledTimes(2);
});

it('routes a response without rport to the Via sent-by port and preserves binary bodies', () => {
  const { socket, emit } = fixture(); const body = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  const request = sipRequest(); request.setHeader('Via', 'SIP/2.0/UDP phone.example:5080;branch=z9hG4bK-legacy');
  const header = request.toString().replace('Content-Length: 0', 'Content-Length: 4');
  socket.emit('message', Buffer.concat([Buffer.from(header), body]), phone);
  expect(socket.send.mock.calls[0][0].subarray(-4)).toEqual(body);
  const forwarded = new SipMessage(socket.send.mock.calls[0][0]); const response = sipResponse(forwarded);
  emit(response, pbx); expect(socket.send.mock.calls[1][1]).toBe(5080);
  const zero = sipRequest(); zero.removeHeader('Max-Forwards'); zero.setHeader('Max-Forwards', '0');
  zero.setHeader('Via', 'SIP/2.0/UDP phone.example:5080;branch=z9hG4bK-local'); emit(zero);
  expect(socket.send.mock.calls[2][1]).toBe(5080);
});

it('never delivers a restored dormant binding to an old UDP endpoint without a supported push provider', () => {
  const { registrations, emit, socket, sender } = fixture();
  sender.supports = () => false;
  registrations.upsert({ ...binding(true), dormant: true });
  emit(incoming(), pbx);
  expect(socket.send).toHaveBeenCalledOnce();
  expect(socket.send.mock.calls[0][0].toString()).toContain('480 Temporarily Unavailable');
  expect(socket.send.mock.calls[0].slice(1)).toEqual([pbx.port, pbx.address]);
});

it('wakes a dormant device but only delivers after a fresh accepted binding', async () => {
  const { registrations, emit, socket, sender } = fixture();
  registrations.upsert({ ...binding(true), dormant: true, clientAddress: '', clientPort: 0 });
  emit(incoming(), pbx); await flushAsync();
  expect(sender.send).toHaveBeenCalledOnce();
  expect(socket.send.mock.calls.every(call => call[2] === pbx.address)).toBe(true);
  registrations.upsert(binding(true)); await flushAsync();
  expect(socket.send.mock.calls.some(call => call[2] === phone.address && call[0].toString().startsWith('INVITE'))).toBe(true);
});
