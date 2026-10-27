import fs from 'fs';
import tls from 'tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogGuard } from '../src/security/DialogGuard';
import { BaseProxy } from '../src/proxies/BaseProxy';
import { TlsProxy } from '../src/proxies/TlsProxy';
import { MemoryStore, RegistrationStore } from '../src/store';
import { SipMessage, SipFrameDecoder } from '../src/sip';
import { createTestConfig, createTestLogger } from './utils';
import { FakeTlsServer, FakeTlsSocket } from './fixtures/transports';
import { flushAsync, sipRequest, sipResponse } from './fixtures/sip';

const cleanups: Array<() => void> = [];
function fixture(autoConnect = true) {
  const records = new MemoryStore(); records.addRecord('pbx.internal', { ip: '10.0.0.50', tlsPort: 5061 });
  const registrations = new RegistrationStore(); const logger = createTestLogger();
  const upstreams: FakeTlsSocket[] = [];
  const client = new FakeTlsSocket();
  let server: FakeTlsServer;
  const connect = vi.fn((_options: tls.ConnectionOptions) => {
    const socket = new FakeTlsSocket(); socket.remoteAddress = '10.0.0.50'; upstreams.push(socket);
    if (autoConnect) queueMicrotask(() => socket.emit('secureConnect'));
    return socket.asSocket();
  });
  const proxy = new TlsProxy(records, createTestConfig(), logger, registrations, {
    tlsOptions: {}, tlsConnect: connect,
    serverFactory: (_options, listener) => { server = new FakeTlsServer(listener); return server.asServer(); },
  });
  proxy.start(); server!.accept(client);
  cleanups.push(() => { client.destroy(); upstreams.forEach(socket => socket.destroy()); });
  return { proxy, records, registrations, logger, client, upstreams, connect, server: server! };
}
const request = (callId = 'call') => sipRequest({ transport: 'TLS', callId });

afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('TLS framing and source validation', () => {
  it.each(['Content-Length: abc', 'l: 0\r\nContent-Length: 0', 'Content-Length: 1000000'])
    ('closes the client on invalid framing %s', async length => {
      const { client, connect } = fixture();
      client.data(request().toString().replace('Content-Length: 0', length));
      await flushAsync();
      expect(client.destroyed).toBe(true); expect(connect).not.toHaveBeenCalled();
    });

  it('closes a complete malformed SIP message before opening an upstream connection', async () => {
    const { client, connect } = fixture();
    client.data(request().toString().replace('Call-ID: call\r\n', ''));
    await flushAsync(); expect(client.destroyed).toBe(true); expect(connect).not.toHaveBeenCalled();
  });

  it('drops an upstream response with a wrong branch, CSeq or Call-ID', async () => {
    const { client, upstreams } = fixture();
    client.data(request().toString()); await flushAsync();
    const accepted = sipResponse(new SipMessage(upstreams[0].writes[0]));
    for (const [name, value] of [['Via', 'SIP/2.0/TLS relay;branch=z9hG4bK-wrong'], ['CSeq', '2 INVITE'], ['Call-ID', 'unknown']]) {
      const spoof = new SipMessage(accepted.toString()); spoof.setHeader(name, value); upstreams[0].data(spoof.toString());
    }
    await flushAsync(); expect(client.writes).toEqual([]);
    upstreams[0].data(accepted.toString()); await flushAsync(); expect(client.writes).toHaveLength(1);
  });

  it('does not forward unroutable requests and returns 483 for exhausted hops except ACK', async () => {
    const { client, connect } = fixture();
    client.data(sipRequest({ target: 'alice@unknown', transport: 'TLS' }).toString());
    const exhausted = request(); exhausted.setHeader('Max-Forwards', '0'); client.data(exhausted.toString());
    const ack = sipRequest({ method: 'ACK', transport: 'TLS' }); ack.setHeader('Max-Forwards', '0'); client.data(ack.toString());
    await flushAsync();
    expect(connect).not.toHaveBeenCalled(); expect(client.writes).toHaveLength(1);
    expect(client.writes[0]).toContain('483 Too Many Hops');
  });

  it('closes a malformed upstream stream without forwarding it to the phone', async () => {
    const { client, upstreams } = fixture(); client.data(request().toString()); await flushAsync();
    upstreams[0].data('SIP/2.0 200 OK\r\nContent-Length: -1\r\n\r\n');
    expect(upstreams[0].destroyed).toBe(true); expect(client.writes).toEqual([]);
  });
});

describe('TLS connection reuse and lifecycle', () => {
  it('coalesces simultaneous handshakes and reuses established PBX connections', async () => {
    const { client, upstreams, connect } = fixture(false);
    client.data(request('first').toString() + request('second').toString());
    expect(connect).toHaveBeenCalledTimes(1);
    expect(upstreams[0].writes).toEqual([]);
    upstreams[0].emit('secureConnect'); await flushAsync();
    expect(upstreams[0].writes).toHaveLength(2);
    client.data(request('third').toString()); await flushAsync();
    expect(connect).toHaveBeenCalledTimes(1); expect(upstreams[0].writes).toHaveLength(3);
  });

  it.each(['error', 'close'])('clears a failed handshake after early %s and permits reconnect', async event => {
    const { client, upstreams, connect, logger } = fixture(false);
    client.data(request('first').toString());
    if (event === 'error') upstreams[0].emit('error', new Error('handshake failed'));
    else upstreams[0].destroy();
    await flushAsync();
    expect(logger.error).toHaveBeenCalled();
    expect(client.writes.at(-1)).toContain('503 Service Unavailable');
    expect(new SipMessage(client.writes.at(-1)!).getHeader('Via')).toHaveLength(1);
    client.data(request('retry').toString()); expect(connect).toHaveBeenCalledTimes(2);
    upstreams[1].emit('secureConnect'); await flushAsync(); expect(upstreams[1].writes).toHaveLength(1);
  });

  it('waits for upstream drain when a write applies backpressure', async () => {
    const { client, upstreams } = fixture(false);
    client.data(request().toString()); upstreams[0].writeBlocked = true;
    upstreams[0].emit('secureConnect'); await flushAsync();
    expect(upstreams[0].listenerCount('drain')).toBe(1);
    upstreams[0].writeBlocked = false; upstreams[0].emit('drain'); await flushAsync();
    expect(upstreams[0].listenerCount('drain')).toBe(0);
  });

  it('reports write failures and established connection errors without unhandled rejection', async () => {
    const { client, upstreams, logger } = fixture(false);
    client.data(request().toString()); upstreams[0].writeError = new Error('write failed');
    upstreams[0].emit('secureConnect'); await flushAsync(); expect(logger.error).toHaveBeenCalled();
    upstreams[0].emit('error', new Error('transport failed')); expect(upstreams[0].destroyed).toBe(true);
    client.emit('error', new Error('client failed')); expect(logger.error).toHaveBeenCalledWith('TLS socket error:', expect.any(Error));
  });

  it('resets idle expiry on activity and reconnects after idle expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, upstreams, connect } = fixture(); client.data(request().toString()); await flushAsync();
    vi.advanceTimersByTime(240_000); client.data(request('activity').toString()); await flushAsync();
    vi.advanceTimersByTime(60_000); expect(upstreams[0].destroyed).toBe(false);
    vi.advanceTimersByTime(240_000); expect(upstreams[0].destroyed).toBe(true);
    client.data(request('reconnect').toString()); await flushAsync(); expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not deliver responses after the originating phone socket closes', async () => {
    const { client, upstreams } = fixture(); client.data(request().toString()); await flushAsync();
    const response = sipResponse(new SipMessage(upstreams[0].writes[0]));
    client.destroy(); upstreams[0].data(response.toString()); await flushAsync(); expect(client.writes).toEqual([]);
  });

  it('rejects a blocked write when its socket closes and removes drain listeners', async () => {
    const { client, upstreams, logger } = fixture(false);
    client.data(request().toString()); upstreams[0].writeBlocked = true; upstreams[0].emit('secureConnect');
    await flushAsync(); expect(upstreams[0].listenerCount('drain')).toBe(1);
    upstreams[0].destroy(); await flushAsync();
    expect(upstreams[0].listenerCount('drain')).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('SIP transaction transport error', expect.any(Error));
  });

  it('removes backpressure listeners after a socket error', async () => {
    const { client, upstreams, logger } = fixture(false);
    client.data(request().toString()); upstreams[0].writeBlocked = true; upstreams[0].emit('secureConnect');
    await flushAsync(); upstreams[0].emit('error', new Error('blocked transport failed')); await flushAsync();
    expect(upstreams[0].listenerCount('drain')).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('SIP transaction transport error', expect.any(Error));
  });

  it('handles a transport closing synchronously inside a blocked write', async () => {
    const { client, upstreams, logger } = fixture(false); client.data(request().toString());
    vi.spyOn(upstreams[0], 'write').mockImplementation(() => { upstreams[0].destroy(); return false; });
    upstreams[0].emit('secureConnect'); await flushAsync();
    expect(upstreams[0].listenerCount('drain')).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('SIP transaction transport error', expect.any(Error));
  });

  it('ignores an old close event after a new upstream connection is established', async () => {
    const { client, upstreams, connect } = fixture(); client.data(request().toString()); await flushAsync();
    upstreams[0].destroy(); client.data(request('replacement').toString()); await flushAsync();
    upstreams[0].emit('close'); client.data(request('reused').toString()); await flushAsync();
    expect(connect).toHaveBeenCalledTimes(2); expect(upstreams[1].writes).toHaveLength(2);
  });
});

describe('PBX to TLS phone failures', () => {
  it('returns 480 for a disconnected non-push phone and does not respond to its ACK', async () => {
    const { client, server, registrations } = fixture();
    registrations.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: client.remoteAddress, clientPort: 5090,
      transport: 'TLS', socket: client.asSocket(), expiresAt: Date.now() + 60_000 });
    client.destroy();
    const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
    pbx.data(sipRequest({ transport: 'TLS', target: 'alice@203.0.113.5' }).toString()); await flushAsync();
    expect(pbx.writes[0]).toContain('480 Temporarily Unavailable');
    pbx.data(sipRequest({ method: 'ACK', transport: 'TLS', target: 'alice@203.0.113.5' }).toString()); await flushAsync();
    expect(pbx.writes).toHaveLength(1); pbx.destroy();
  });

  it('does not deliver requests from the wrong PBX tenant, unknown user or unsupported transport', async () => {
    const { client, server, registrations } = fixture();
    registrations.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: client.remoteAddress, clientPort: 5090,
      transport: 'UDP', expiresAt: Date.now() + 60_000 });
    const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
    const invite = sipRequest({ transport: 'TLS', target: 'alice@203.0.113.5' }); pbx.data(invite.toString());
    pbx.data(sipRequest({ transport: 'TLS', target: 'unknown@203.0.113.5' }).toString());
    invite.setHeader('Route', '<sip:203.0.113.5;lr;sr-domain=other.internal>'); pbx.data(invite.toString());
    await flushAsync(); expect(client.writes).toEqual([]); pbx.destroy();
  });
});

describe('additional TLS failure boundaries', () => {
  it('reports unexpected decoder failures and closes the input socket', () => {
    const { client, logger } = fixture();
    vi.spyOn(SipFrameDecoder.prototype, 'feedBuffers').mockImplementationOnce(() => { throw new Error('decoder failed'); });
    client.data(request().toString());
    expect(client.destroyed).toBe(true);
    expect(logger.error).toHaveBeenCalledWith('Unexpected SIP frame decode error', expect.any(Error));
  });

  it('does not create connections for unsupported URI targets or routes without TLS', async () => {
    const { client, records, connect } = fixture();
    records.addRecord('udp-only', { ip: '10.0.0.2', udpPort: 5060 });
    client.data(sipRequest({ target: 'alice@udp-only', transport: 'TLS' }).toString());
    const star = request(); star.startLine = 'OPTIONS * SIP/2.0'; star.setHeader('CSeq', '1 OPTIONS'); client.data(star.toString());
    await flushAsync(); expect(connect).not.toHaveBeenCalled();
  });

  it('logs response delivery failures without treating them as successful', async () => {
    const { client, upstreams, logger } = fixture(); client.data(request().toString()); await flushAsync();
    client.writeError = new Error('phone connection failed');
    upstreams[0].data(sipResponse(new SipMessage(upstreams[0].writes[0])).toString()); await flushAsync();
    expect(logger.error).toHaveBeenCalledWith('SIP transaction transport error', expect.any(Error));
  });

  it('enforces PBX hop limits and logs local response failures', async () => {
    const { server, logger } = fixture(); const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
    const exhausted = sipRequest({ target: 'alice@203.0.113.5', transport: 'TLS' }); exhausted.setHeader('Max-Forwards', '0');
    pbx.data(exhausted.toString()); await flushAsync(); expect(pbx.writes[0]).toContain('483 Too Many Hops');
    const ack = sipRequest({ method: 'ACK', target: 'alice@203.0.113.5', transport: 'TLS' }); ack.setHeader('Max-Forwards', '0');
    pbx.data(ack.toString()); expect(pbx.writes).toHaveLength(1);
    pbx.writeError = new Error('closed'); pbx.data(exhausted.toString()); await flushAsync();
    expect(logger.error).toHaveBeenCalledWith('SIP transaction transport error', expect.any(Error)); pbx.destroy();
  });

  it('logs phone delivery errors for a known PBX and ignores off-relay targets', async () => {
    const { client, server, registrations, logger } = fixture();
    registrations.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: client.remoteAddress, clientPort: client.remotePort,
      transport: 'TLS', socket: client.asSocket(), expiresAt: Date.now() + 60000 });
    const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
    pbx.data(sipRequest({ target: 'alice@elsewhere', transport: 'TLS' }).toString());
    expect(client.writes).toHaveLength(0);
    client.writeError = new Error('phone failed'); pbx.data(sipRequest({ target: 'alice@203.0.113.5', transport: 'TLS', callId: 'delivery-failure' }).toString());
    await flushAsync(); expect(logger.error).toHaveBeenCalledWith('SIP transaction transport error', expect.any(Error)); pbx.destroy();
  });
});

describe('TLS credentials', () => {
  it('loads configured key and certificate and reports unreadable files', () => {
    const files = vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('credential'));
    const logger = createTestLogger(); const config = createTestConfig();
    const factory = vi.fn((_options: tls.TlsOptions, listener: (socket: tls.TLSSocket) => void) => new FakeTlsServer(listener).asServer());
    new TlsProxy(new MemoryStore(), config, logger, new RegistrationStore(), { serverFactory: factory });
    expect(factory.mock.calls[0][0]).toEqual({ key: Buffer.from('credential'), cert: Buffer.from('credential'), requestCert: false, minVersion: 'TLSv1.2', handshakeTimeout: 10_000 });
    files.mockImplementation(() => { throw new Error('key unavailable'); });
    expect(() => new TlsProxy(new MemoryStore(), config, logger, new RegistrationStore(), { serverFactory: factory })).toThrow('key unavailable');
    expect(logger.error).toHaveBeenCalledWith('Failed to load TLS credentials', expect.any(Error));
  });
});

describe('TLS call hijack and exhaustion regressions', () => {
  it('rejects another socket attempting to control an established call', async () => {
    const { client, server, upstreams } = fixture();
    client.data(request().toString()); await flushAsync();
    upstreams[0].data(sipResponse(new SipMessage(upstreams[0].writes[0])).toString()); await flushAsync();
    const attacker = new FakeTlsSocket(); server.accept(attacker);
    const bye = sipRequest({ method: 'BYE', cseq: 2, callId: 'call', transport: 'TLS' });
    bye.setHeader('To', '<sip:alice@pbx.internal>;tag=callee');
    attacker.data(bye.toString()); await flushAsync();
    expect(attacker.writes[0]).toContain('481 Call/Transaction Does Not Exist');
    expect(upstreams[0].writes).toHaveLength(1);
    client.data(bye.toString()); await flushAsync(); expect(upstreams[0].writes).toHaveLength(2);
    attacker.destroy();
  });

  it('silently drops unknown ACK and routing injection, and rejects a mismatched registration Contact', async () => {
    const { client, connect } = fixture();
    client.data(sipRequest({ method: 'ACK', transport: 'TLS' }).toString());
    const injection = request(); injection.setHeader('Record-Route', '<sip:attacker;lr>'); client.data(injection.toString());
    const register = sipRequest({ method: 'REGISTER', transport: 'TLS' }); register.setHeader('Contact', '<sip:victim@phone>');
    client.data(register.toString()); await flushAsync();
    expect(connect).not.toHaveBeenCalled(); expect(client.writes).toHaveLength(1);
    expect(client.writes[0]).toContain('400 Bad Request');
  });

  it('closes over-budget peers and idle connections', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const { client } = fixture();
    expect(client.setTimeout).toHaveBeenCalledWith(60_000, expect.any(Function));
    for (let i = 0; i < 201; i++) client.data('\r\n');
    expect(client.destroyed).toBe(true);
    const other = fixture().client;
    const expire = other.setTimeout.mock.calls[0][1] as () => void; expire(); expect(other.destroyed).toBe(true);
  });

  it('limits complete messages in a coalesced TLS packet', () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const { client } = fixture();
    client.data(sipRequest({ method: 'OPTIONS', target: 'alice@unknown', transport: 'TLS' }).toString().repeat(201));
    expect(client.destroyed).toBe(true);
  });

  it('times out a stalled upstream handshake without forwarding a call', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const { client, upstreams, logger } = fixture(false);
    client.data(request().toString()); await flushAsync();
    vi.advanceTimersByTime(10_000); await flushAsync();
    expect(upstreams[0].destroyed).toBe(true); expect(upstreams[0].writes).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not forward an INVITE after its originating connection closes during handshake', async () => {
    const { client, upstreams } = fixture(false); client.data(request().toString()); await flushAsync();
    client.destroy(); upstreams[0].emit('secureConnect'); await flushAsync(); expect(upstreams[0].writes).toEqual([]);
  });

  it('rejects new TLS sockets at capacity', () => {
    const { proxy, server } = fixture();
    const sockets = (proxy as unknown as { incomingSockets: Set<tls.TLSSocket> }).incomingSockets;
    for (let i = sockets.size; i < 2000; i++) sockets.add(new FakeTlsSocket().asSocket());
    const overflow = new FakeTlsSocket(); server.accept(overflow); expect(overflow.destroyed).toBe(true);
    sockets.clear();
  });

  it('rejects ambiguous inbound PBX tenants on a shared address', () => {
    const { records, server } = fixture(); records.addRecord('other.internal', { ip: '10.0.0.50', tlsPort: 5062 });
    const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
    pbx.data(sipRequest({ target: 'alice@203.0.113.5', domain: 'unknown.internal', transport: 'TLS' }).toString());
    expect(pbx.destroyed).toBe(true);
  });
});

it('drops data from a previous upstream connection after replacement', async () => {
  // This assertion concerns stale sockets; a legitimate timed 100 Trying must not race it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { client, upstreams } = fixture(); client.data(request().toString()); await flushAsync();
  const old = upstreams[0]; old.destroy(); client.data(request('new').toString()); await flushAsync();
  const currentResponse = sipResponse(new SipMessage(upstreams[1].writes[0]));
  old.data(currentResponse.toString()); await flushAsync(); expect(client.writes).toEqual([]);
  upstreams[1].data(currentResponse.toString()); await flushAsync(); expect(client.writes).toHaveLength(1);
});


it('fails closed when INVITE or transaction capacity is exhausted', async () => {
  const { client, connect, server, registrations } = fixture();
  const inviteCapacity = vi.spyOn(DialogGuard.prototype, 'trackInvite').mockReturnValue(false);
  client.data(request().toString()); await flushAsync(); expect(connect).not.toHaveBeenCalled(); inviteCapacity.mockRestore();
  vi.spyOn(BaseProxy.prototype as unknown as { storeClient: () => boolean }, 'storeClient').mockReturnValue(false);
  client.data(request().toString()); await flushAsync(); expect(connect).not.toHaveBeenCalled();
  registrations.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: client.remoteAddress, clientPort: client.remotePort,
    transport: 'TLS', socket: client.asSocket(), expiresAt: Date.now() + 60_000 });
  const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
  pbx.data(sipRequest({ target: 'alice@203.0.113.5', transport: 'TLS' }).toString()); await flushAsync();
  expect(client.writes).toEqual([]); pbx.destroy();
});

it('reports unexpected ingress authorization errors without an unhandled rejection', async () => {
  const { client, logger, connect } = fixture();
  vi.spyOn(DialogGuard.prototype, 'authorize').mockImplementation(() => { throw new Error('authorization failure'); });
  client.data(request().toString()); await flushAsync();
  expect(connect).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('Failed to process inbound TLS SIP request', expect.any(Error));
});

it('permits the registered phone to end a PBX-initiated call using the reversed dialog tags', async () => {
  const { client, server, registrations, upstreams } = fixture();
  registrations.upsert({ domain: 'pbx.internal', user: 'alice', clientAddress: client.remoteAddress, clientPort: client.remotePort,
    transport: 'TLS', socket: client.asSocket(), expiresAt: Date.now() + 60_000 });
  const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
  pbx.data(sipRequest({ target: 'alice@203.0.113.5', transport: 'TLS', callId: 'incoming-call' }).toString()); await flushAsync();
  client.data(sipResponse(new SipMessage(client.writes[0])).toString()); await flushAsync();
  expect(pbx.writes[0]).toContain('200 OK');
  const bye = sipRequest({ method: 'BYE', transport: 'TLS', callId: 'incoming-call', cseq: 2 });
  bye.setHeader('From', '<sip:alice@pbx.internal>;tag=callee'); bye.setHeader('To', '<sip:bob@example.com>;tag=caller');
  client.data(bye.toString()); await flushAsync();
  expect(upstreams[0].writes[0]).toContain('BYE sip:alice@pbx.internal SIP/2.0'); pbx.destroy();
});

it('answers fragmented RFC 5626 pings on phone and PBX TLS connections', async () => {
  const { client, upstreams, connect } = fixture();
  client.data('\r\n\r'); client.data('\n'); await flushAsync();
  expect(client.writes).toEqual(['\r\n']); expect(connect).not.toHaveBeenCalled();
  client.data(request().toString()); await flushAsync();
  upstreams[0].data('\r\n\r\n'); await flushAsync(); expect(upstreams[0].writes.at(-1)).toBe('\r\n');
});

it('reports failed keepalive pong writes without an unhandled rejection', async () => {
  const { client, logger } = fixture(); client.writeError = new Error('cannot write pong');
  client.data('\r\n\r\n'); await flushAsync();
  expect(logger.error).toHaveBeenCalledWith('Failed to send TLS keepalive pong', expect.any(Error));
});

it('rejects unsupported proxy extensions on phone and PBX TLS ingress, without responding to ACK', async () => {
  const { client, server, connect } = fixture(); const extension = request(); extension.setHeader('Proxy-Require', 'outbound');
  client.data(extension.toString()); await flushAsync();
  expect(client.writes[0]).toContain('420 Bad Extension'); expect(client.writes[0]).toContain('Unsupported: outbound');
  expect(connect).not.toHaveBeenCalled();
  const pbx = new FakeTlsSocket(); pbx.remoteAddress = '10.0.0.50'; server.accept(pbx);
  pbx.data(extension.toString()); await flushAsync(); expect(pbx.writes[0]).toContain('420 Bad Extension');
  const ack = sipRequest({ method: 'ACK', transport: 'TLS' }); ack.startLine = 'ACK tel:+441234 SIP/2.0';
  client.data(ack.toString()); await flushAsync(); expect(client.writes).toHaveLength(1);
  client.writeError = new Error('cannot write rejection'); client.data(extension.toString()); await flushAsync();
  expect(connect).not.toHaveBeenCalled(); pbx.destroy();
});

it('preserves binary request and response bodies over TLS', async () => {
  const { client, upstreams } = fixture(); const body = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
  const header = request().toString().replace('Content-Length: 0', 'Content-Type: application/octet-stream\r\nContent-Length: 4');
  client.data(Buffer.concat([Buffer.from(header), body])); await flushAsync();
  expect(upstreams[0].rawWrites[0].subarray(-4)).toEqual(body);
  const response = sipResponse(new SipMessage(upstreams[0].rawWrites[0])).toString().replace('Content-Length: 0', 'Content-Length: 4');
  upstreams[0].data(Buffer.concat([Buffer.from(response), body])); await flushAsync();
  expect(client.rawWrites[0].subarray(-4)).toEqual(body);
});

it('rejects unsolicited response identities before updating dialog/registration state', async () => {
  const f = fixture(); f.client.data(request().toBuffer()); await flushAsync();
  const response = sipResponse(new SipMessage(f.upstreams[0].rawWrites[0]));
  response.setHeader('From', '<sip:bob@example.com>;tag=forged');
  f.upstreams[0].data(response.toBuffer()); await flushAsync();
  expect(f.client.writes).toEqual([]);
});

it('rejects PBX Path tokens from another domain and bounds stale flow delivery', async () => {
  const f = fixture(); f.client.data(request('connect').toBuffer()); await flushAsync();
  const otherToken = f.registrations.createFlowToken({ domain: 'other.internal', user: 'alice', flow: 'closed' });
  const incoming = sipRequest({ target: 'alice@203.0.113.5', callId: 'foreign-path' });
  incoming.setHeader('Route', `<sip:${otherToken}@203.0.113.5;lr;sr-domain=pbx.internal>`);
  f.upstreams[0].data(incoming.toBuffer()); await flushAsync();
  expect(f.upstreams[0].writes.at(-1)).toContain('403 Forbidden');
});
