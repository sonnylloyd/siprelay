#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const cwd = __dirname;
const secondTenant = process.argv.includes('--second');
const service = secondTenant ? 'pbx-b' : 'pbx';
const domain = secondTenant ? 'pbx-b.test' : 'pbx.test';
const compose = ['compose', '-f', path.join(cwd, 'compose.yml'),
  ...(secondTenant ? ['-f', path.join(cwd, 'compose.two-pbx.yml')] : [])];
function docker(args, input, timeout = 15_000) {
  return execFileSync('docker', [...compose, ...args], { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout });
}
// The Compose project name and service select only this dedicated lab, never a production PBX.
const ids = docker(['ps', '-q', service]).trim();
if (!ids || ids.includes('\n')) throw new Error('Expected exactly one running lab PBX');
const project = execFileSync('docker', ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', ids], { encoding: 'utf8' }).trim();
if (project !== 'siprelay-izpbx-lab') throw new Error('Refusing to configure a PBX outside the lab project');
let ready = false;
const readyDeadline = Date.now() + 60_000;
while (Date.now() < readyDeadline) {
  try { ready = docker(['exec', '-T', service, 'asterisk', '-rx', 'core show version']).startsWith('Asterisk '); } catch { /* PBX may still be booting. */ }
  if (ready) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
if (!ready) throw new Error('Lab Asterisk did not become ready in 60 seconds');
try { docker(['exec', '-T', service, 'test', '-f', '/etc/asterisk/pjsip_custom.conf']); }
catch { docker(['exec', '-T', service, 'fwconsole', 'reload'], undefined, 60_000); }

const credentialsFile = path.join(cwd, secondTenant ? '.lab-credentials-b.json' : '.lab-credentials.json');
let users;
if (fs.existsSync(credentialsFile)) users = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
else {
  users = Object.fromEntries(['9001', '9002'].map(user => [user, crypto.randomBytes(24).toString('hex')]));
  fs.writeFileSync(credentialsFile, JSON.stringify(users), { mode: 0o600, flag: 'wx' });
}
for (const user of ['9001', '9002']) {
  if (!/^[a-f0-9]{48}$/.test(users[user])) throw new Error('Invalid lab credential file');
}
const tlsDirectory = path.join(cwd, '.tls');
const tlsEnabled = process.argv.includes('--tls');
function installCertificate(service, source, target, owner) {
  const content = fs.readFileSync(path.join(tlsDirectory, source));
  docker(['exec', '-T', '-u', '0', service, 'sh', '-c', 'umask 077; cat > "$1"; chown "$2" "$1"', 'sh', target, owner], content);
}
if (tlsEnabled) {
  installCertificate(service, `${service}.key`, '/etc/asterisk/keys/siprelay-lab.key', 'asterisk:asterisk');
  installCertificate(service, `${service}.crt`, '/etc/asterisk/keys/siprelay-lab.crt', 'asterisk:asterisk');
  installCertificate(service, 'ca.crt', '/etc/asterisk/keys/siprelay-lab-ca.crt', 'asterisk:asterisk');
  if (!secondTenant) {
    installCertificate('siprelay', 'siprelay.key', '/ssl/server.key', 'appuser:appgroup');
    installCertificate('siprelay', 'siprelay.crt', '/ssl/server.crt', 'appuser:appgroup');
    installCertificate('siprelay', 'ca.crt', '/ssl/lab-ca.crt', 'appuser:appgroup');
  }
}
const tlsTransport = tlsEnabled ? `[lab-tls]
type=transport
protocol=tls
bind=0.0.0.0:5061
allow_reload=yes
cert_file=/etc/asterisk/keys/siprelay-lab.crt
priv_key_file=/etc/asterisk/keys/siprelay-lab.key
ca_list_file=/etc/asterisk/keys/siprelay-lab-ca.crt
verify_server=yes
verify_client=no
method=tlsv1_2

` : '';
const pjsip = tlsTransport + `[lab-tcp]\ntype=transport\nprotocol=tcp\nbind=0.0.0.0:5060\nallow_reload=yes\n\n` + Object.entries(users).map(([user, password]) => `
[${user}]
type=endpoint
context=siprelay-lab
disallow=all
allow=ulaw
auth=lab-auth-${user}
aors=${user}
direct_media=no
rewrite_contact=no
force_rport=yes
rtp_symmetric=yes

[lab-auth-${user}]
type=auth
auth_type=userpass
username=${user}
password=${password}

[${user}]
type=aor
max_contacts=3
remove_existing=no
minimum_expiration=30
maximum_expiration=3600
support_path=yes
`).join('\n');
const extensions = `[siprelay-lab]
exten => 9001,1,Dial(PJSIP/9001,30,b(siprelay-lab-mark^s^1))
 same => n,Hangup()
exten => 9002,1,Dial(PJSIP/9002,30,b(siprelay-lab-mark^s^1))
 same => n,Hangup()
[siprelay-lab-mark]
exten => s,1,Set(PJSIP_HEADER(add,X-SIPRelay-Lab-Tenant)=${domain})
 same => n,Return()
`;
function install(file, content, includeFile) {
  docker(['exec', '-T', service, 'sh', '-c', 'umask 077; cat > "$1"; chown asterisk:asterisk "$1"', 'sh', `/etc/asterisk/${file}`], content);
  const includePath = `/etc/asterisk/${includeFile}`;
  const existing = docker(['exec', '-T', service, 'cat', includePath]).replaceAll('\\n', '\n');
  const line = `#include ${file}`;
  const updated = existing.split('\n').includes(line) ? existing : `${existing.trimEnd()}\n${line}\n`;
  docker(['exec', '-T', service, 'sh', '-c', 'cat > "$1"', 'sh', includePath], updated);

}
install('siprelay_lab_pjsip.conf', pjsip, 'pjsip_custom.conf');
install('siprelay_lab_extensions.conf', extensions, 'extensions_custom.conf');
docker(['exec', '-T', service, 'asterisk', '-rx', 'module reload res_pjsip.so']);
docker(['exec', '-T', service, 'asterisk', '-rx', 'dialplan reload']);
const endpoints = docker(['exec', '-T', service, 'asterisk', '-rx', 'pjsip show endpoints']);
if (!/Endpoint:\s+9001\s/.test(endpoints) || !/Endpoint:\s+9002\s/.test(endpoints)) throw new Error('Lab endpoints did not load');
if (tlsEnabled && !secondTenant) docker(['restart', 'siprelay']);
console.log(`Provisioned lab-only 9001/9002 on ${domain}. Credentials remain private.`);
