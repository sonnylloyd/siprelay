#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Phone, call, transport, routePort } = require('./interop.cjs');
const cwd = __dirname;
const credentialsA = JSON.parse(fs.readFileSync(path.join(cwd, '.lab-credentials.json')));
const credentialsB = JSON.parse(fs.readFileSync(path.join(cwd, '.lab-credentials-b.json')));
const compose = ['compose', '-f', path.join(cwd, 'compose.yml'), '-f', path.join(cwd, 'compose.two-pbx.yml')];
function docker(args, options = {}) {
  return execFileSync('docker', [...compose, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 75_000, ...options });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForRoutes(predicate) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:18080/api/routes', { signal: AbortSignal.timeout(1500) });
      const routes = (await response.json()).routes;
      if (predicate(routes)) return routes;
    } catch { /* Bounded discovery/startup wait. */ }
    await sleep(250);
  }
  throw new Error('Timed out waiting for the expected two-tenant routing map');
}
const domainA = 'pbx.test', domainB = 'pbx-b.test';
const routeFor = (routes, domain) => routes.find(route => route.host === domain && route[routePort]);
function containsContact(response, phone) {
  return response.all('contact').some(value => value.includes(phone.contact.slice(1, -1)));
}
// Run inside the second PBX namespace, so the trusted source IP really is tenant B.
// UDP uses that PBX's actual port 5060. Capture only the response to our unique test Call-ID.
const injectFromPbx = String.raw`
import sys,json,socket,ssl,struct,time,random
p=json.load(sys.stdin)
payload=p['packet'].encode()
if p['transport']=='UDP':
    receive=socket.socket(socket.AF_INET,socket.SOCK_RAW,socket.IPPROTO_UDP)
    receive.settimeout(3)
    send=socket.socket(socket.AF_INET,socket.SOCK_RAW,socket.IPPROTO_RAW)
    header=struct.pack('!BBHHHBBH4s4s',0x45,0,28+len(payload),random.randrange(65536),0,64,17,0,socket.inet_aton(p['source']),socket.inet_aton(p['relay']))
    udp=struct.pack('!HHHH',5060,p['port'],8+len(payload),0)
    send.sendto(header+udp+payload,(p['relay'],p['port']))
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        packet=receive.recv(65535)
        offset=(packet[0]&15)*4
        if socket.inet_ntoa(packet[12:16])!=p['relay']:continue
        src,dst=struct.unpack('!HH',packet[offset:offset+4])
        body=packet[offset+8:]
        if src==p['port'] and dst==5060 and p['callId'].encode() in body:
            print(body.decode().split('\r\n')[0]);break
    else:raise RuntimeError('No isolated injection response')
    send.close();receive.close()
else:
    connection=socket.create_connection((p['relay'],p['port']),timeout=3)
    if p['transport']=='TLS':
        context=ssl.create_default_context(cafile='/etc/asterisk/keys/siprelay-lab-ca.crt')
        connection=context.wrap_socket(connection,server_hostname='siprelay.test')
    connection.sendall(payload)
    reply=b''
    while b'\r\n\r\n' not in reply:
        chunk=connection.recv(65535)
        if not chunk:raise RuntimeError('Lab peer closed before the response headers')
        reply+=chunk
    print(reply.decode().split('\r\n')[0])
    connection.close()
`;
async function main() {
  assert.ok(credentialsA['9001'] !== credentialsB['9001'], 'tenants must have different credentials');
  const phones = [];
  let secondStopped = false;
  try {
    const routes = await waitForRoutes(routes => routeFor(routes, domainA) && routeFor(routes, domainB));
    const routeA = routeFor(routes, domainA), routeB = routeFor(routes, domainB);
    assert.notEqual(routeA.ip, routeB.ip, 'separate PBX addresses');
    assert.equal(routeA[routePort], routeB[routePort], 'same port on separate PBXs');
    assert.ok(/^172\.30\.231\./.test(routeB.ip), 'injection restricted to the isolated lab network');
    console.log(`PASS ${transport}: both Docker domains discovered on separate PBXs with matching ports`);
    for (const [domain, credentials, suffix] of [[domainA, credentialsA, '-a'], [domainB, credentialsB, '-b']]) {
      for (const user of ['9001', '9002']) {
        const phone = await new Phone(user, suffix, domain, credentials).open();
        phone.requireTenantMarker = true; phones.push(phone);
      }
    }
    const [a1, a2, b1, b2] = phones;
    a1.regId = b1.regId = `same-registration-${crypto.randomUUID()}`;
    a1.tag = b1.tag = crypto.randomUUID();
    const registrations = await Promise.all(phones.map(phone => phone.register()));
    for (let i = 0; i < phones.length; i++) {
      assert.ok(containsContact(registrations[i], phones[i]), 'own Contact returned');
      assert.ok(registrations[i].all('path').some(value => value.includes(`sr-domain=${phones[i].domain}`)), 'own tenant Path echoed');
    }
    assert.equal(a1.lastRegister.callId, b1.lastRegister.callId);
    assert.equal(a1.lastRegister.cseq, b1.lastRegister.cseq);
    console.log(`PASS ${transport}: overlapping extensions and registration Call-ID/CSeq stay tenant-specific`);
    const sharedCallId = `same-dialog-${crypto.randomUUID()}`;
    await Promise.all([call(a1, a2, 'answer', false, false, sharedCallId), call(b1, b2, 'answer', false, false, sharedCallId)]);
    console.log(`PASS ${transport}: simultaneous same-Call-ID calls reach the correct PBX and device`);
    const wrong = await new Phone('9001', '-wrong-password', domainB, credentialsA).open();
    try {
      const result = await wrong.authenticated('REGISTER', { contact: `${wrong.contact};expires=300`, extra: ['Expires: 300'] });
      assert.ok([401, 403].includes(result.response.status), 'tenant A credentials rejected by tenant B');
    } finally { wrong.close(); }
    assert.ok(containsContact(await b1.register(300, true), b1));
    console.log(`PASS ${transport}: credentials from the other PBX cannot register`);
    const stolen = a1.request('INVITE', { uri: b2.contact.slice(1, -1), to: `<sip:9002@${domainB}>`, routes: registrations[3].all('path') });
    const denied = await a1.final(stolen); assert.equal(denied.status, 403); a1.ack(stolen, denied);
    assert.ok(!b2.queue.some(message => message.get('call-id') === stolen.callId), 'stolen flow did not reach the device');
    console.log(`PASS ${transport}: another tenant's phone Path cannot be stolen`);
    const callId = `foreign-pbx-${crypto.randomUUID()}`;
    const foreignPath = registrations[1].get('path').replace(`sr-domain=${domainA}`, `sr-domain=${domainB}`);
    const relayPort = transport === 'TLS' ? 15061 : 15060;
    const packet = [`INVITE ${a2.contact.slice(1, -1)} SIP/2.0`,
      `Via: SIP/2.0/${transport} ${routeB.ip}:${routeB[routePort]};branch=z9hG4bK-${crypto.randomUUID()};rport`,
      'Max-Forwards: 70', `From: <sip:9001@${domainB}>;tag=${crypto.randomUUID()}`, `To: <sip:9002@${domainB}>`,
      `Call-ID: ${callId}`, 'CSeq: 1 INVITE', `Contact: <sip:9001@${routeB.ip}>`, `Route: ${foreignPath}`, 'Content-Length: 0', '', ''].join('\r\n');
    const injected = docker(['exec', '-T', 'pbx-b', 'python3', '-c', injectFromPbx], {
      input: JSON.stringify({ packet, callId, transport, relay: '172.30.231.10', port: relayPort, source: routeB.ip }), timeout: 10_000,
    });
    assert.match(injected, /^SIP\/2\.0 403 /);
    assert.ok(!a2.queue.some(message => message.get('call-id') === callId), 'other PBX did not reach tenant A phone');
    console.log(`PASS ${transport}: trusted PBX B cannot use tenant A's flow token`);
    if (process.argv.includes('--lifecycle')) {
      assert.equal(transport, 'UDP', 'run lifecycle once in the UDP profile');
      docker(['stop', '-t', '10', 'pbx-b']); secondStopped = true;
      await waitForRoutes(routes => routeFor(routes, domainA) && !routes.some(route => route.host === domainB));
      await call(a1, a2);
      const unavailable = a1.request('OPTIONS', { uri: `sip:9001@${domainB}`, to: `<sip:9001@${domainB}>` });
      await assert.rejects(a1.final(unavailable), /Timed out/);
      console.log('PASS lifecycle: stopped PBX B is removed; PBX A still calls; no fallback to A');
      docker(['start', 'pbx-b']);
      execFileSync(process.execPath, [path.join(cwd, 'provision.cjs'), '--second', '--tls'], { cwd, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] });
      secondStopped = false;
      await waitForRoutes(routes => routeFor(routes, domainA) && routeFor(routes, domainB));
      await b1.register(); await b2.register(); await call(b1, b2);
      assert.ok(containsContact(await a1.register(300, true), a1));
      console.log('PASS lifecycle: restarted PBX B is rediscovered and calls resume without changing A');
    }
    await a2.register(0);
    assert.ok(containsContact(await b2.register(300, true), b2), 'unregister A does not remove B');
    console.log(`PASS ${transport}: unregister in one tenant leaves the other intact`);
  } finally {
    if (secondStopped) docker(['start', 'pbx-b']);
    await Promise.all(phones.map(phone => phone.register(0).catch(() => {})));
    phones.forEach(phone => phone.close());
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
