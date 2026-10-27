// Run after npm run build, using a dedicated test database/SQLite file.
// Example: PUSH_STORAGE=sqlite PUSH_SQLITE_PATH=/tmp/push-test.sqlite node scripts/check-push-storage.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Config } = require('../dist/configurations');
const { RegistrationStore } = require('../dist/store');
const { createPushStorage } = require('../dist/store/persistence/createPushStorage');
const { PushCoordinator } = require('../dist/push/PushCoordinator');
const { SipMessage } = require('../dist/sip');
const logger = { info() {}, debug() {}, warn() {}, error() {} };
const config = new Config();
assert(['sqlite', 'mysql'].includes(config.PUSH_STORAGE), 'Select sqlite or mysql; use a dedicated test database');
const domain = `storage-check-${crypto.randomUUID()}.invalid`, other = `other-${domain}`, user = 'alice';
const binding = { domain, user, id: 'phone', transport: 'UDP', clientAddress: '192.0.2.10', clientPort: 5999,
  push: { provider: 'fcm', app: 'test.app', token: 'test-device-token' }, expiresAt: Date.now() + 60_000 };
let store, coordinator;
async function open() { store = new RegistrationStore(createPushStorage(config), logger); await store.initialize(); }
async function run() {
  await open();
  const token = store.createFlowToken({ domain, user, flow: 'phone-flow' });
  store.upsert({ ...binding, flowToken: token }); store.upsert({ ...binding, domain: other }); await store.close();
  await open();
  const restored = store.getByFlowToken(token);
  assert(restored?.dormant); assert.equal(restored.clientAddress, ''); assert.equal(restored.clientPort, 0);
  assert.equal(restored.socket, undefined); assert.equal(restored.expiresAt, binding.expiresAt);
  let pushes = 0, delivered = 0;
  coordinator = new PushCoordinator(store, { supports: () => true, send: async () => { pushes++; } }, logger);
  const request = new SipMessage('INVITE sip:alice@relay.invalid SIP/2.0\r\nVia: SIP/2.0/UDP pbx;branch=z9hG4bK-check\r\nCall-ID: storage-check\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n');
  assert(coordinator.enqueue(request, 'trusted-pbx', restored, { ready: () => { delivered++; }, fail: () => assert.fail('Unexpected push failure') }));
  await new Promise(setImmediate); assert.equal(pushes, 1); assert.equal(delivered, 0);
  store.upsert({ ...binding, domain: other }); await new Promise(setImmediate); assert.equal(delivered, 0);
  store.upsert({ ...binding, flowToken: token }); await new Promise(setImmediate); assert.equal(delivered, 1);
  coordinator.dispose(); coordinator = undefined;
  store.upsert({ ...binding, flowToken: token, push: { ...binding.push, token: 'rotated-device-token' } }); await store.close();
  await open(); assert.equal(store.getByFlowToken(token).push.token, 'rotated-device-token');
  store.remove(domain, user, 'phone'); await store.close();
  await open(); assert.equal(store.getByFlowToken(token), undefined); assert(store.get(other, user));
  store.upsert({ ...binding, push: undefined }); await store.close();
  await open(); assert.equal(store.get(domain, user), undefined);
  console.log(`${config.PUSH_STORAGE}: restart recovery, signed routes, dormant wake-up, tenant isolation, token rotation and unregister passed`);
}
run().catch(() => { console.error('Push storage integration check failed (details suppressed to protect database credentials)'); process.exitCode = 1; })
  .finally(async () => {
    coordinator?.dispose();
    try { if (store) { store.remove(domain, user); store.remove(other, user); await store.close(); } }
    catch { console.error('Push storage integration fixture cleanup failed'); process.exitCode = 1; }
  });
