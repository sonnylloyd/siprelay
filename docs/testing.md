# Tests and coverage

Use Node.js 22.13 or newer from the repository root:

```bash
npm ci
npm run typecheck
npm run build
npm run test:coverage
```

`npm test` skips coverage; `npm run test:watch` watches changes. Coverage thresholds remain
**99% lines/statements, 99% functions and 93% branches**. Failed assertions, unhandled async
errors or unmet thresholds fail the command. No thresholds were lowered for the new engine.

The HTML report is `coverage/index.html`; JSON reports are `coverage/coverage-summary.json`
and `coverage/coverage-final.json`. Reports are gitignored. Coverage includes production
TypeScript, including otherwise unimported modules. Only declaration/barrel files and the
listener-starting executable `src/server.ts` are excluded. The actual composition root and
transport initialization are tested separately. Its tests allow 15 seconds for cold dynamic
module imports under instrumentation; this does not change SIP timers or other test timeouts.

Vitest uses one fork at a time. Tests use fake sockets/providers, test credentials and fake
SIP timers. No APNs/FCM calls, Docker daemon or PBX are required. TypeScript checks both
production code and tests, including unused declarations and fake transport/mocking types.

## Regression scope

- SIP syntax/compact headers, list splitting, quoted extensions and unambiguous tags, CSeq,
  URI ports/IPv6, header injection, Max-Forwards, Proxy-Require and SIPS restrictions.
- Stream segmentation/pipelining, every two-part split of multibyte frames, malformed or
  ambiguous Content-Length, binary bodies, frame limits and fragmented CRLF keepalive replies.
- INVITE/non-INVITE client/server state machines, UDP retransmissions, timers, response replay,
  Accepted states and repeated/forked 2xx, failure ACK, CANCEL and answer/cancellation races.
  Capacity, transport failure, unrouted expiry and late/deferred release are exercised.
- UDP/TCP/TLS forwarding, expected endpoint/socket/branch/tag checks, TLS connection reuse,
  handshake failure/timeouts, configured PBX DNS identity and CA, backpressure and idle cleanup.
- Path negotiation, transparent Contacts, multiple accepted bindings, expiry/unregister/query,
  signed tokens, device-flow/tenant isolation, tampered routes and stale route rejection.
- Dialog control ownership and rejection of forged BYE/REFER/UPDATE/ACK/CANCEL/responses.
- APNs/FCM payload/authentication/signatures, provider error paths, bounded late-call queues,
  cancellation, device-specific wake matching, accepted re-registration and disconnected phones.
- Docker event ordering/reconciliation, malformed events, label ports/TLS identity, replacement
  ownership, shared-IP routing, HTTP API/dashboard, config, logging and dependency wiring.

## Latest validation

On 27 October 2026, **455 tests across 28 files pass**. Production/test type checks and
application build pass. Coverage thresholds pass unchanged:

| Metric | Coverage |
| --- | ---: |
| Statements | 99.05% (1995/2014) |
| Branches | 94.82% (1540/1624) |
| Functions | 100% (399/399) |
| Lines | 99.69% (1613/1618) |

These are unit/regression measurements, not certification or proof of production readiness.

## Live acceptance

The [isolated izPBX lab](../examples/izpbx-lab/README.md) is prepared for the user's
`izdock/izpbx-asterisk` target. Compose interpolation/schema validation and shell syntax checks
pass. Container build/startup and live UDP/TCP/TLS signalling now pass on the isolated bridge.
See [the live report](interop-results.md) for results, exact versions and remaining checks.

The [standards matrix](standards-review.md) records remaining implementation gates and the
required PBX/UA/SIPp scenarios. Test real packet loss/duplication/reordering, NAT/media,
background mobile lifecycle, APNs/FCM delivery, certificate validation, Docker reconnect,
load/soak and service restarts. Unit coverage does not validate those systems. Cross-transport
routing, full Outbound/push negotiation, early NOTIFY and general DNS/route processing remain
open; do not describe this release as fully RFC-compliant or production-certified.

Push persistence tests exercise real SQLite restart recovery, stable signed routes, dormant
devices, expiry, token rotation, unregister, transactional rollback and corrupt database
rejection. MySQL adapter unit tests cover parameter binding, rollback/release and TLS settings;
see [push storage](push-storage.md) for configuration and operational limits.

After a build, `scripts/check-push-storage.cjs` runs persistence and wake-up checks against a
real backend. Use a **dedicated test database/file** and the environment from the storage
guide, for example:

```bash
PUSH_STORAGE=sqlite PUSH_SQLITE_PATH=/tmp/siprelay-test.sqlite node scripts/check-push-storage.cjs
# For MySQL, set PUSH_MYSQL_* for an isolated test database, then:
PUSH_STORAGE=mysql node scripts/check-push-storage.cjs
```

The check uses a mock push sender, so it needs no APNs/FCM credentials and does not wake a
real phone. It creates unique tenant fixtures and removes them afterward. It verifies restart
recovery, route identity, dormant-device deferral, tenant isolation, token rotation and removal.
