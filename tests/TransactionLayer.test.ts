import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionLayer } from '../src/sip/transactions/TransactionLayer';
import { SipMessage } from '../src/sip';
import { sipRequest, sipResponse } from './fixtures/sip';

const layers: TransactionLayer[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }));
afterEach(() => { layers.splice(0).forEach(layer => layer.dispose()); vi.useRealTimers(); });
const message = (packet: Buffer) => new SipMessage(packet);
function fixture(method = 'INVITE', reliable = false) {
  const upstream = vi.fn((_packet: Buffer) => {}), downstream = vi.fn((_packet: Buffer) => {});
  const terminated = vi.fn(), error = vi.fn();
  const layer = new TransactionLayer({ onClientTerminated: terminated, onError: error }); layers.push(layer);
  const original = sipRequest({ method });
  expect(layer.receiveRequest(original, 'phone', reliable, upstream)).toBe(false);
  const forwarded = original.clone(); forwarded.addViaTop('SIP/2.0/UDP relay;branch=z9hG4bK-proxy');
  const key = layer.serverKey(original, 'phone');
  expect(layer.forward(forwarded, key, 'pbx', reliable, downstream)).toBe(true);
  const respond = (status: number, to = 'callee') => {
    const response = sipResponse(forwarded, status); response.setHeader('To', `<sip:alice@pbx.internal>;tag=${to}`);
    return layer.receiveResponse(response, 'pbx');
  };
  return { layer, upstream, downstream, original, forwarded, key, respond, terminated, error };
}

describe('INVITE client transactions', () => {
  it('retransmits UDP with exponential Timer A, then stops at a provisional response', () => {
    const f = fixture(); expect(f.downstream).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499); expect(f.downstream).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); expect(f.downstream).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000); expect(f.downstream).toHaveBeenCalledTimes(3);
    f.respond(180); vi.advanceTimersByTime(30_000); expect(f.downstream).toHaveBeenCalledTimes(3);
    expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(180);
  });
  it('generates a hop-local Trying but does not forward the PBX Trying', () => {
    const f = fixture(); f.respond(100); expect(f.upstream).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200); expect(f.upstream).toHaveBeenCalledOnce();
    expect(message(f.upstream.mock.calls[0][0]).getStatusCode()).toBe(100);
    expect(message(f.upstream.mock.calls[0][0]).getHeader('Via')).toHaveLength(1);
  });
  it('times out an unanswered INVITE at 64*T1 and sends a final response', () => {
    const f = fixture(); vi.advanceTimersByTime(32_000);
    expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(408);
    expect(f.terminated).toHaveBeenCalledWith(f.forwarded.getTransactionKey());
  });
  it('ACKs a failure locally and repeats the ACK, without forwarding duplicate failures', () => {
    const f = fixture(); f.respond(486); const ack = message(f.downstream.mock.calls.at(-1)![0]);
    expect(ack.getMethod()).toBe('ACK'); expect(ack.getHeader('Via')).toHaveLength(1);
    expect(ack.getTopVia()).toBe(f.forwarded.getTopVia()); expect(ack.getToTag()).toBe('callee');
    expect(ack.getCSeqNumber()).toBe('1'); expect(ack.body).toBe('');
    const count = f.upstream.mock.calls.length; f.respond(486);
    expect(message(f.downstream.mock.calls.at(-1)![0]).getMethod()).toBe('ACK');
    expect(f.upstream).toHaveBeenCalledTimes(count);
    vi.advanceTimersByTime(32_000); expect(f.terminated).toHaveBeenCalled();
  });
  it('retains accepted transactions for repeated/forked 2xx and absorbs repeated INVITEs', () => {
    const f = fixture(); expect(f.respond(200)).toBe(true); expect(f.respond(200)).toBe(true); expect(f.respond(200, 'fork')).toBe(true);
    expect(f.upstream).toHaveBeenCalledTimes(3); expect(f.downstream).toHaveBeenCalledOnce();
    expect(f.layer.receiveRequest(f.original, 'phone', false, f.upstream)).toBe(true);
    expect(f.upstream).toHaveBeenCalledTimes(3); expect(f.respond(486)).toBe(false);
    vi.advanceTimersByTime(32_000); expect(f.respond(200)).toBe(false);
  });
  it('sends end-to-end 2xx ACK once without creating another transaction', () => {
    const f = fixture(); f.respond(200);
    const ack = sipRequest({ method: 'ACK', branch: 'z9hG4bK-success-ack' }); ack.setHeader('To', '<sip:alice@pbx.internal>;tag=callee');
    expect(f.layer.receiveRequest(ack, 'phone', false, f.upstream)).toBe(false);
    expect(f.layer.forward(ack, 'unused', 'pbx', false, f.downstream)).toBe(true);
    expect(message(f.downstream.mock.calls.at(-1)![0]).getMethod()).toBe('ACK');
  });
  it('uses Timer C only after provisional progress, sends CANCEL and bounds cancellation wait', () => {
    const f = fixture(); f.respond(180); vi.advanceTimersByTime(181_000);
    expect(message(f.downstream.mock.calls.at(-1)![0]).getMethod()).toBe('CANCEL');
    vi.advanceTimersByTime(32_000); expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(408);
  });
  it('refreshes Timer C with non-100 provisional progress', () => {
    const f = fixture(); f.respond(180); vi.advanceTimersByTime(100_000); f.respond(183);
    vi.advanceTimersByTime(100_000); expect(f.downstream).toHaveBeenCalledOnce();
  });
  it('does not retransmit reliable requests or keep completed error transactions alive', () => {
    const f = fixture('INVITE', true); vi.advanceTimersByTime(2000); expect(f.downstream).toHaveBeenCalledOnce();
    f.respond(486); vi.advanceTimersByTime(0); expect(f.terminated).toHaveBeenCalled();
  });
});

describe('server retransmissions and ACK', () => {
  it('replays provisional/final responses and retransmits a UDP final until the matching ACK', () => {
    const f = fixture(); f.respond(180); f.layer.receiveRequest(f.original, 'phone', false, f.upstream);
    expect(f.upstream).toHaveBeenCalledTimes(2); f.respond(486); vi.advanceTimersByTime(500);
    expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(486);
    const ack = sipRequest({ method: 'ACK' }); ack.setHeader('To', '<sip:alice@pbx.internal>;tag=wrong');
    expect(f.layer.receiveRequest(ack, 'phone', false, f.upstream)).toBe(false);
    ack.setHeader('To', '<sip:alice@pbx.internal>;tag=callee');
    expect(f.layer.receiveRequest(ack, 'phone', false, f.upstream)).toBe(true);
    expect(f.layer.receiveRequest(ack, 'phone', false, f.upstream)).toBe(true);
    const count = f.upstream.mock.calls.length; vi.advanceTimersByTime(6000); expect(f.upstream).toHaveBeenCalledTimes(count);
    expect(f.layer.receiveRequest(ack, 'phone', false, f.upstream)).toBe(false);
  });
  it('does not allow a retransmission to change the request identity or response callback', () => {
    const f = fixture(); f.respond(180); const attacker = vi.fn();
    const changed = f.original.clone(); changed.setHeader('From', '<sip:bob@example.com>;tag=wrong');
    expect(f.layer.receiveRequest(changed, 'phone', false, attacker)).toBe(true);
    changed.setHeader('From', f.original.getFirstHeader('From')!); changed.startLine = 'INVITE sip:other@pbx.internal SIP/2.0';
    expect(f.layer.receiveRequest(changed, 'phone', false, attacker)).toBe(true); expect(attacker).not.toHaveBeenCalled();
  });
  it('does not overwrite a completed or confirmed server response', () => {
    const f = fixture(); f.respond(486); const count = f.upstream.mock.calls.length;
    f.layer.reply(f.original, 'phone', new SipMessage(f.original.createResponse(200, 'OK')));
    expect(f.upstream).toHaveBeenCalledTimes(count);
    const ack = sipRequest({ method: 'ACK' }); ack.setHeader('To', '<sip:alice@pbx.internal>;tag=callee');
    f.layer.receiveRequest(ack, 'phone', false, f.upstream);
    f.layer.reply(f.original, 'phone', new SipMessage(f.original.createResponse(486, 'Busy')));
    expect(f.upstream).toHaveBeenCalledTimes(count);
  });
  it('bounds routing without an outbound client and rejects late release after cancellation', () => {
    const layer = new TransactionLayer(); layers.push(layer); const send = vi.fn(), target = vi.fn(); const invite = sipRequest();
    layer.receiveRequest(invite, 'flow', false, send);
    const cancel = sipRequest({ method: 'CANCEL' }); expect(layer.receiveRequest(cancel, 'flow', false, send)).toBe(true);
    expect(send.mock.calls.map(([packet]) => message(packet).getStatusCode())).toEqual([200, 487]);
    expect(layer.forward(invite, layer.serverKey(invite, 'flow'), 'pbx', false, target)).toBe(false); expect(target).not.toHaveBeenCalled();
  });
  it('bounds unrouted INVITEs, and silently expires unrouted non-INVITEs', () => {
    const layer = new TransactionLayer(); layers.push(layer); const send = vi.fn(); const invite = sipRequest();
    layer.receiveRequest(invite, 'flow', true, send); layer.receiveRequest(sipRequest({ method: 'OPTIONS' }), 'other', true, send);
    vi.advanceTimersByTime(181_000); expect(send.mock.calls.map(([packet]) => message(packet).getStatusCode())).toEqual([100, 408]);
  });
});

describe('CANCEL transaction isolation', () => {
  it('responds locally and generates a separate CANCEL client transaction using the INVITE branch', () => {
    const f = fixture(); f.respond(180); const cancel = sipRequest({ method: 'CANCEL' });
    expect(f.layer.receiveRequest(cancel, 'phone', false, f.upstream)).toBe(true);
    expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(200);
    const outbound = message(f.downstream.mock.calls.at(-1)![0]); expect(outbound.getMethod()).toBe('CANCEL');
    expect(outbound.getTopVia()).toBe(f.forwarded.getTopVia()); expect(outbound.getHeader('Via')).toHaveLength(1);
    const response = sipResponse(outbound); const count = f.upstream.mock.calls.length;
    f.layer.receiveResponse(response, 'pbx'); expect(f.upstream).toHaveBeenCalledTimes(count);
    f.respond(487); expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(487);
  });
  it('defers outbound CANCEL until receiving a provisional response', () => {
    const f = fixture(); f.layer.receiveRequest(sipRequest({ method: 'CANCEL' }), 'phone', false, f.upstream);
    expect(f.downstream).toHaveBeenCalledOnce(); f.respond(100);
    expect(message(f.downstream.mock.calls.at(-1)![0]).getMethod()).toBe('CANCEL');
  });
  it('rejects an unknown or wrong-flow CANCEL and does not cancel an accepted call', () => {
    const f = fixture(); const cancel = sipRequest({ method: 'CANCEL' }); const attacker = vi.fn();
    f.layer.receiveRequest(cancel, 'attacker', false, attacker); expect(message(attacker.mock.calls[0][0]).getStatusCode()).toBe(481);
    f.respond(200); f.layer.receiveRequest(cancel, 'phone', false, f.upstream);
    expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(200); expect(f.downstream).toHaveBeenCalledOnce();
  });
  it('rejects a CANCEL with the wrong From tag', () => {
    const f = fixture(); const cancel = sipRequest({ method: 'CANCEL' }); cancel.setHeader('From', '<sip:bob@example.com>;tag=wrong');
    f.layer.receiveRequest(cancel, 'phone', false, f.upstream); expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(481);
  });
});

describe('non-INVITE transactions and trust boundaries', () => {
  it('caps Timer E at T2, keeps it at T2 after provisional, and expires with no synthetic 408', () => {
    const f = fixture('OPTIONS'); vi.advanceTimersByTime(7500); expect(f.downstream).toHaveBeenCalledTimes(5);
    f.respond(180); const count = f.downstream.mock.calls.length;
    vi.advanceTimersByTime(4000); expect(f.downstream).toHaveBeenCalledTimes(count + 1);
    vi.advanceTimersByTime(25_000); expect(f.terminated).toHaveBeenCalled();
    expect(f.upstream.mock.calls.some(([packet]) => message(packet).getStatusCode() === 408)).toBe(false);
  });
  it('replays the server final on a duplicate request but forwards a client final once', () => {
    const f = fixture('REGISTER'); f.respond(200); expect(f.respond(200)).toBe(false);
    expect(f.layer.receiveRequest(f.original, 'phone', false, f.upstream)).toBe(true);
    expect(f.upstream).toHaveBeenCalledTimes(2); vi.advanceTimersByTime(5000); expect(f.terminated).toHaveBeenCalled();
  });
  it('rejects responses from another peer, Call-ID, CSeq, branch or dialog', () => {
    const f = fixture(); const response = sipResponse(f.forwarded);
    expect(f.layer.receiveResponse(response, 'attacker')).toBe(false);
    for (const [name, value] of [['Call-ID', 'other'], ['CSeq', '2 INVITE'], ['Via', 'SIP/2.0/UDP relay;branch=other'], ['From', '<sip:bob@example.com>;tag=other']]) {
      const bad = response.clone(); bad.setHeader(name, value); expect(f.layer.receiveResponse(bad, 'pbx')).toBe(false);
    }
    expect(f.downstream).toHaveBeenCalledOnce(); expect(f.upstream).not.toHaveBeenCalled();
  });
  it('validates the To tag for requests already in a dialog', () => {
    const f = fixture(); const request = sipRequest({ method: 'INVITE', cseq: 2 }); request.setHeader('To', '<sip:alice@pbx.internal>;tag=existing');
    f.layer.receiveRequest(request, 'phone', true, f.upstream); const outgoing = request.clone(); outgoing.addViaTop('SIP/2.0/TLS relay;branch=next');
    f.layer.forward(outgoing, f.layer.serverKey(request, 'phone'), 'pbx', true, f.downstream);
    expect(f.layer.receiveResponse(sipResponse(outgoing), 'pbx')).toBe(false);
  });
  it('rejects invalid timer configurations and bounds transaction capacity', () => {
    expect(() => new TransactionLayer({ t1: 0 })).toThrow(); expect(() => new TransactionLayer({ timerC: 180_000 })).toThrow();
    const layer = new TransactionLayer({ maxEntries: 1 }); layers.push(layer); const send = vi.fn(); const invite = sipRequest();
    layer.receiveRequest(invite, 'one', false, send); layer.receiveRequest(invite, 'two', false, send);
    expect(message(send.mock.calls[0][0]).getStatusCode()).toBe(503);
    expect(layer.reply(invite, 'missing', sipResponse(invite))).toBe(false);
  });
  it('converts synchronous and asynchronous transport failures into bounded failures', async () => {
    for (const fail of [() => { throw new Error('write'); }, () => Promise.reject(new Error('write'))]) {
      const layer = new TransactionLayer({ onError: vi.fn() }); layers.push(layer); const send = vi.fn(); const request = sipRequest();
      layer.receiveRequest(request, 'flow', true, send); layer.forward(request, layer.serverKey(request, 'flow'), 'pbx', true, fail);
      await Promise.resolve(); await Promise.resolve(); expect(message(send.mock.calls.at(-1)![0]).getStatusCode()).toBe(503);
    }
  });
  it('disposes every timer and rejects late responses', () => {
    const f = fixture(); f.layer.dispose(); expect(vi.getTimerCount()).toBe(0); expect(f.respond(200)).toBe(false);
  });
});

it('rejects new outbound work when client capacity is occupied by a completed transaction', () => {
  const layer = new TransactionLayer({ maxEntries: 1 }); layers.push(layer);
  const send = vi.fn(), target = vi.fn(); const first = sipRequest({ method: 'OPTIONS', callId: 'first' });
  layer.receiveRequest(first, 'phone', true, send);
  layer.forward(first, layer.serverKey(first, 'phone'), 'pbx', false, target);
  layer.receiveResponse(sipResponse(first), 'pbx');
  vi.advanceTimersByTime(0); // Reliable server is gone, but the UDP client retains Timer K.
  const second = sipRequest({ method: 'OPTIONS', callId: 'second' });
  expect(layer.receiveRequest(second, 'phone', true, send)).toBe(false);
  expect(layer.forward(second, layer.serverKey(second, 'phone'), 'pbx', false, target)).toBe(false);
  expect(message(send.mock.calls.at(-1)![0]).getStatusCode()).toBe(503);
  expect(target).toHaveBeenCalledOnce();
});

it('reports a retransmission write failure without retaining the failed client', () => {
  const f = fixture(); f.downstream.mockImplementation(() => { throw new Error('network failed after first send'); });
  vi.advanceTimersByTime(500);
  expect(message(f.upstream.mock.calls.at(-1)![0]).getStatusCode()).toBe(503);
  expect(f.terminated).toHaveBeenCalledOnce();
});

it('contains asynchronous local-response send failures when no error hook is installed', async () => {
  const layer = new TransactionLayer(); layers.push(layer);
  const rejectSend = () => Promise.reject(new Error('closed source'));
  expect(layer.receiveRequest(sipRequest({ method: 'CANCEL' }), 'unknown', true, rejectSend)).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  layer.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it('bounds Timer C when there is no capacity for the generated CANCEL', () => {
  const layer = new TransactionLayer({ maxEntries: 1 }); layers.push(layer);
  const source = vi.fn(), target = vi.fn(); const invite = sipRequest();
  layer.receiveRequest(invite, 'phone', true, source);
  layer.forward(invite, layer.serverKey(invite, 'phone'), 'pbx', true, target);
  layer.receiveResponse(sipResponse(invite, 180), 'pbx');
  vi.advanceTimersByTime(181_000);
  expect(target).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(32_000);
  expect(message(source.mock.calls.at(-1)![0]).getStatusCode()).toBe(408);
});
