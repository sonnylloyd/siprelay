#!/usr/bin/env node
'use strict';
// Independent wire-level probe: intentionally does not import SIPRelay's SIP parser.
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const users = JSON.parse(fs.readFileSync(path.join(__dirname, '.lab-credentials.json'), 'utf8'));
const transport = process.argv.includes('--tls') ? 'TLS' : process.argv.includes('--tcp') ? 'TCP' : 'UDP';
const routePort = transport === 'UDP' ? 'udpPort' : transport === 'TCP' ? 'tcpPort' : 'tlsPort';
const ca = transport === 'TLS' ? fs.readFileSync(path.join(__dirname, '.tls', 'ca.crt')) : undefined;
const host = '172.30.231.10', port = transport === 'TLS' ? 15061 : 15060, localHost = '172.30.231.1';
const unique = () => crypto.randomBytes(12).toString('hex');
function parse(packet) {
  const [head, body = ''] = packet.toString().split('\r\n\r\n');
  const [start, ...lines] = head.split('\r\n'); const headers = {};
  for (const line of lines) {
    const split = line.indexOf(':'); if (split < 0) continue;
    const name = line.slice(0, split).toLowerCase(); (headers[name] ??= []).push(line.slice(split + 1).trim());
  }
  return { start, headers, body, status: Number(start.split(' ')[1]) || undefined, method: start.split(' ')[0],
    get: name => headers[name.toLowerCase()]?.[0], all: name => headers[name.toLowerCase()] ?? [] };
}
class Phone extends EventEmitter {
  constructor(user, suffix = '', domain = 'pbx.test', credentials = users) { super(); this.domain = domain; this.credentials = credentials; this.user = user; this.suffix = suffix; this.queue = []; this.cached = new Map(); this.seq = 0; this.tag = unique(); this.regId = unique(); }
  async open() {
    if (transport === 'UDP') {
      this.socket = dgram.createSocket('udp4'); this.socket.on('message', packet => this.receive(packet));
      this.socket.bind(0, '0.0.0.0'); await once(this.socket, 'listening'); this.localPort = this.socket.address().port;
    } else {
      this.socket = transport === 'TLS' ? tls.connect({ host, port, ca, servername: 'siprelay.test', minVersion: 'TLSv1.2' }) : net.connect({ host, port }); let buffer = Buffer.alloc(0);
      this.socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length) {
          if (buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) { buffer = buffer.subarray(2); continue; }
          const end = buffer.indexOf('\r\n\r\n'); if (end < 0) break;
          const length = Number(buffer.subarray(0, end).toString().match(/\r\nContent-Length:\s*(\d+)/i)?.[1] ?? 0);
          if (buffer.length < end + 4 + length) break;
          this.receive(buffer.subarray(0, end + 4 + length)); buffer = buffer.subarray(end + 4 + length);
        }
      });
      this.socket.setTimeout(8000, () => this.socket.destroy(new Error('Lab connection handshake timeout')));
      await once(this.socket, transport === 'TLS' ? 'secureConnect' : 'connect');
      this.socket.setTimeout(0); this.localPort = this.socket.localPort;
    }
    this.contact = `<sip:device-${this.user}${this.suffix}@phone.invalid:${this.localPort};transport=${transport.toLowerCase()}>`;
    return this;
  }
  key(message) { return [message.get('call-id'), message.get('cseq'), message.get('via')].join('|'); }
  receive(packet) {
    const message = parse(packet);
    if (process.env.LAB_TRACE === '1') console.log('TRACE receive', this.user, message.start, message.get('cseq'));
    const cached = !message.status && this.cached.get(this.key(message));
    if (cached) { this.send(cached); return; }
    this.queue.push(message); this.emit('packet');
  }
  send(packet) { if (transport === 'UDP') this.socket.send(Buffer.from(packet), port, host); else this.socket.write(packet); }
  wait(predicate, label, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = this.queue.findIndex(predicate); if (index < 0) return;
        clearTimeout(timer); this.removeListener('packet', check); resolve(this.queue.splice(index, 1)[0]);
      };
      const timer = setTimeout(() => { this.removeListener('packet', check); reject(new Error(`Timed out: ${label} (${transport}, UA ${this.user})`)); }, timeout);
      this.on('packet', check); check();
    });
  }
  response(request, status, reason, body = '', extra = []) {
    const to = /;tag=/i.test(request.get('to')) ? request.get('to') : `${request.get('to')};tag=${this.tag}`;
    const raw = [`SIP/2.0 ${status} ${reason}`, ...request.all('via').map(value => `Via: ${value}`),
      `From: ${request.get('from')}`, `To: ${to}`, `Call-ID: ${request.get('call-id')}`, `CSeq: ${request.get('cseq')}`,
      ...request.all('record-route').map(value => `Record-Route: ${value}`), `Contact: ${this.contact}`, ...extra,
      ...(body ? ['Content-Type: application/sdp'] : []), `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n');
    this.cached.set(this.key(request), raw); this.send(raw);
  }
  request(method, options = {}) {
    const request = { method, uri: `sip:${this.domain}`, callId: unique(), cseq: ++this.seq, branch: `z9hG4bK-${unique()}`,
      from: `<sip:${this.user}@${this.domain}>;tag=${this.tag}`, to: `<sip:${this.user}@${this.domain}>`, contact: this.contact, ...options };
    this.transmit(request); return request;
  }
  transmit(r) {
    if (r.method === 'INVITE') this.lastInvite = r;
    if (r.method === 'REGISTER') this.lastRegister = r;
    r.raw = [`${r.method} ${r.uri} SIP/2.0`, `Via: SIP/2.0/${transport} ${localHost}:${this.localPort};branch=${r.branch};rport`,
      'Max-Forwards: 70', `From: ${r.from}`, `To: ${r.to}`, `Call-ID: ${r.callId}`, `CSeq: ${r.cseq} ${r.method}`,
      ...(r.contact ? [`Contact: ${r.contact}`] : []), 'Supported: path', ...(r.routes ?? []).map(route => `Route: ${route}`),
      ...(r.authorization ? [`Authorization: ${r.authorization}`] : []), ...(r.extra ?? []),
      ...(r.body ? ['Content-Type: application/sdp'] : []), `Content-Length: ${Buffer.byteLength(r.body ?? '')}`, '', r.body ?? ''].join('\r\n');
    if (process.env.LAB_TRACE === '1') console.log('TRACE send', this.user, r.method, r.cseq, r.uri);
    this.send(r.raw);
  }
  final(r) { return this.wait(m => m.status >= 200 && m.get('call-id') === r.callId && m.get('cseq') === `${r.cseq} ${r.method}`, `${r.method} final`); }
  async authenticated(method, options) {
    let request = this.request(method, options), response = await this.final(request);
    if (response.status === 401) {
      if (method === 'INVITE') this.ack(request, response);
      const challenge = Object.fromEntries([...response.get('www-authenticate').matchAll(/([\w-]+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3]]));
      const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase(); assert.equal(algorithm, 'MD5', 'Lab probe currently expects MD5 challenge');
      const hash = value => crypto.createHash('md5').update(value).digest('hex');
      const cnonce = unique(), nc = '00000001';
      const qop = challenge.qop?.split(',').map(v => v.trim()).includes('auth') ? 'auth' : undefined;
      const ha1 = hash(`${this.user}:${challenge.realm}:${this.credentials[this.user]}`), ha2 = hash(`${method}:${request.uri}`);
      const digest = hash(qop ? `${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}` : `${ha1}:${challenge.nonce}:${ha2}`);
      const authorization = `Digest username="${this.user}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${request.uri}", response="${digest}", algorithm=MD5${qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : ''}${challenge.opaque ? `, opaque="${challenge.opaque}"` : ''}`;
      request = this.request(method, { ...options, callId: request.callId, cseq: request.cseq + 1, authorization });
      response = await this.final(request);
    }
    return { request, response };
  }
  ack(request, response) {
    this.request('ACK', { uri: response.status < 300 ? response.get('contact')?.replace(/^<|>.*$/g, '') ?? request.uri : request.uri,
      callId: request.callId, cseq: request.cseq, branch: response.status >= 300 ? request.branch : `z9hG4bK-${unique()}`,
      from: request.from, to: response.get('to'), routes: response.all('record-route').slice().reverse(), contact: undefined });
  }
  async register(expires = 300, query = false) {
    const result = await this.authenticated('REGISTER', { callId: this.regId, cseq: this.seq += 2,
      contact: query ? undefined : `${this.contact};expires=${expires}`, extra: [`Expires: ${expires}`] });
    assert.equal(result.response.status, 200, 'REGISTER accepted');
    if (!query && expires) assert.ok(result.response.all('path').some(p => p.includes('ft.')), 'registrar echoes authenticated Path');
    return result.response;
  }
  close() { if (transport === 'UDP') this.socket.close(); else this.socket.destroy(); }
}
const sdp = () => `v=0\r\no=lab 1 1 IN IP4 ${localHost}\r\ns=lab\r\nc=IN IP4 ${localHost}\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n`;
async function call(caller, callee, mode = 'answer', reverseBye = false, securityChecks = false, callId) {
  const incomingWait = callee.wait(m => m.method === 'INVITE', 'PBX INVITE via Path');
  const attempt = caller.authenticated('INVITE', { ...(callId ? { callId } : {}), uri: `sip:${callee.user}@${callee.domain}`, to: `<sip:${callee.user}@${callee.domain}>`, body: sdp() });
  const incoming = await incomingWait;
  if (callee.requireTenantMarker) {
    assert.equal(incoming.get('x-siprelay-lab-tenant'), callee.domain, 'correct originating PBX');
    assert.equal(incoming.start.split(' ')[1], callee.contact.slice(1, -1), 'correct tenant Contact');
  }
  assert.ok(incoming.start.includes(`device-${callee.user}`), 'original device Contact preserved');
  assert.ok(incoming.all('record-route').some(r => r.includes('ft.')), 'device flow in Record-Route');
  callee.response(incoming, 180, 'Ringing');
  if (mode === 'busy') {
    callee.response(incoming, 486, 'Busy Here'); const { request, response } = await attempt;
    assert.equal(response.status, 486);
    if (transport === 'UDP') {
      assert.equal((await caller.final(request)).status, 486, 'UDP final retransmits while failure ACK is withheld');
      console.log('PASS UDP: failure response retransmission after withheld ACK');
    }
    caller.ack(request, response);
    await callee.wait(m => m.method === 'ACK' && m.get('call-id') === incoming.get('call-id'), 'failure ACK');
    return;
  }
  if (mode === 'cancel') {
    const progress = await caller.wait(m => m.status === 180 && m.get('call-id') === caller.lastInvite.callId, 'ringing before cancellation');
    // Find the authenticated INVITE's exact branch/CSeq from the caller's sent request.
    const original = caller.lastInvite;
    assert.ok(original, 'authenticated INVITE captured');
    const cancel = caller.request('CANCEL', { ...original, method: 'CANCEL', body: '', contact: undefined, authorization: undefined });
    assert.equal((await caller.final(cancel)).status, 200);
    const downstream = await callee.wait(m => m.method === 'CANCEL', 'PBX CANCEL');
    callee.response(downstream, 200, 'OK'); callee.response(incoming, 487, 'Request Terminated');
    const { request, response } = await attempt; assert.equal(response.status, 487); caller.ack(request, response);
    assert.ok(progress); return;
  }
  if (securityChecks) {
    const rogue = await new Phone(callee.user, '-rogue', callee.domain, callee.credentials).open();
    try {
      let released = false; attempt.then(() => { released = true; });
      rogue.response(incoming, 200, 'OK', sdp());
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(released, false, 'forged answer from another phone flow rejected');
    } finally { rogue.close(); }
  }
  callee.response(incoming, 200, 'OK', sdp()); const { request, response } = await attempt;
  assert.equal(response.status, 200);
  if (securityChecks) {
    assert.equal((await caller.final(request)).status, 200, 'repeated 2xx forwarded while success ACK is withheld');
    console.log(`PASS ${transport}: repeated 2xx delivery after withheld ACK`);
  }
  caller.ack(request, response);
  await callee.wait(m => m.method === 'ACK' && m.get('call-id') === incoming.get('call-id'), 'success ACK');
  const sender = reverseBye ? callee : caller, receiver = reverseBye ? caller : callee;
  const byeOptions = reverseBye ? { uri: incoming.get('contact').replace(/^<|>.*$/g, ''), callId: incoming.get('call-id'), from: `${incoming.get('to')};tag=${callee.tag}`, to: incoming.get('from'), routes: incoming.all('record-route') }
    : { uri: response.get('contact').replace(/^<|>.*$/g, ''), callId: request.callId, from: request.from, to: response.get('to'), routes: response.all('record-route').slice().reverse() };
  if (securityChecks) {
    const rogue = await new Phone(sender.user, '-rogue', sender.domain, sender.credentials).open();
    try {
      const hijack = rogue.request('BYE', byeOptions);
      assert.ok([403, 481].includes((await rogue.final(hijack)).status), 'stolen-dialog BYE rejected');
    } finally { rogue.close(); }
  }
  const bye = sender.request('BYE', byeOptions);
  const received = await receiver.wait(m => m.method === 'BYE', 'remote BYE'); receiver.response(received, 200, 'OK');
  assert.equal((await sender.final(bye)).status, 200, 'BYE accepted');
}
async function main() {
  const phones = [];
  try {
    let routes;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        routes = await (await fetch('http://127.0.0.1:18080/api/routes')).json();
        if (routes.routes.some(route => route.host === 'pbx.test' && route[routePort])) break;
      } catch { /* Listener/discovery may still be starting after a container rebuild. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(routes, 'lab relay API ready');
    assert.ok(routes.routes.some(route => route.host === 'pbx.test' && route[routePort]), 'Docker route discovered');
    console.log(`PASS ${transport}: Docker label discovery`);
    if (transport === 'TLS') {
      await new Promise((resolve, reject) => {
        const wrong = tls.connect({ host, port, ca, servername: 'wrong.test', minVersion: 'TLSv1.2' });
        wrong.setTimeout(5000, () => wrong.destroy(new Error('Certificate-name probe timed out')));
        wrong.once('secureConnect', () => { wrong.destroy(); reject(new Error('Wrong TLS certificate name accepted')); });
        wrong.once('error', error => { try { assert.equal(error.code, 'ERR_TLS_CERT_ALTNAME_INVALID'); resolve(); } catch (failure) { reject(failure); } });
      });
      console.log('PASS TLS: mismatched relay certificate name rejected');
      await new Promise((resolve, reject) => {
        const untrusted = tls.connect({ host, port, servername: 'siprelay.test', minVersion: 'TLSv1.2' });
        untrusted.setTimeout(5000, () => untrusted.destroy(new Error('Certificate-trust probe timed out')));
        untrusted.once('secureConnect', () => { untrusted.destroy(); reject(new Error('Untrusted lab CA accepted')); });
        untrusted.once('error', error => {
          try { assert.ok(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code), 'untrusted CA rejected'); resolve(); }
          catch (failure) { reject(failure); }
        });
      });
      console.log('PASS TLS: untrusted relay CA rejected');
    }
    const a = await new Phone('9001').open(); phones.push(a);
    if (process.argv.includes('--expect-upstream-cert-failure')) {
      assert.equal(transport, 'TLS');
      const result = await a.authenticated('REGISTER', { contact: `${a.contact};expires=300`, extra: ['Expires: 300'] });
      assert.equal(result.response.status, 503, 'upstream certificate mismatch fails closed');
      console.log('PASS TLS: mismatched PBX certificate identity fails closed with 503');
      return;
    }
    const b = await new Phone('9002').open(); phones.push(b);
    await a.register(); await b.register(); console.log(`PASS ${transport}: challenged REGISTER and registrar Path echo`);
    await a.register(); assert.ok((await a.register(300, true)).all('contact').length); console.log(`PASS ${transport}: registration refresh/query`);
    const duplicate = a.lastRegister; a.send(duplicate.raw); assert.equal((await a.final(duplicate)).status, 200);
    console.log(`PASS ${transport}: duplicate REGISTER response replay`);
    await call(a, b, 'answer', false, true); console.log(`PASS ${transport}: forged answer and stolen-dialog BYE rejected`); console.log(`PASS ${transport}: INVITE/180/200/ACK and caller BYE`);
    await call(b, a, 'answer', true); console.log(`PASS ${transport}: reverse call and callee BYE`);
    await call(a, b, 'busy'); console.log(`PASS ${transport}: busy/486 and failure ACK`);
    await call(a, b, 'cancel'); console.log(`PASS ${transport}: CANCEL/200/487`);
    const second = await new Phone('9002', '-second').open(); phones.push(second); await second.register();
    assert.equal((await second.register(300, true)).all('contact').length, 2); await second.register(0);
    assert.equal((await b.register(300, true)).all('contact').length, 1); console.log(`PASS ${transport}: separate Contact bindings and selective unregister`);
    await a.register(0); await b.register(0); console.log(`PASS ${transport}: unregister`);
  } finally {
    await Promise.all(phones.map(phone => phone.register(0).catch(() => {})));
    phones.forEach(phone => phone.close());
  }
}
module.exports = { Phone, call, transport, routePort };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
