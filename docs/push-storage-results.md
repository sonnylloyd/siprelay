# Push storage validation — 2026-10-27

The configurable storage implementation passed:

- 497 unit tests across 30 files. Overall coverage: 99.13% statements, 95.22% branches,
  100% functions, 99.71% lines. All five new persistence modules have 100% coverage in
  all four categories. Existing coverage thresholds were retained.
- Type checking, the production build, and the Docker image build.
- Real SQLite recovery inside the final Docker image, running as the non-root app user
  with a persistent Docker volume.
- Real MySQL 8.0.45 recovery using a dedicated temporary database, both plaintext lab
  connectivity and certificate-verified TLS. TLS rejects both an untrusted CA and a trusted certificate with the wrong hostname.

The reusable `scripts/check-push-storage.cjs` check closes and reconstructs the registration
store and backend. It verifies retained signed route identity, preserved expiry, dormant
restoration, push deferral until a fresh matching registration, isolation from another tenant,
token rotation, per-device unregister and loss of push support. SQLite unit tests additionally
exercise corrupt database rejection, transactional rollback, expiry pruning and private file
permissions. Writer tests cover coalescing, races, outages, retry, readiness and failed shutdown
flushes. MySQL unit tests exercise parameterized queries, timeouts, rollback, connection release
and TLS configuration.

The integration sender is a mock; no real APNs/FCM credentials or phones are used. These checks
validate persistence and coordinator behavior, not phone OS wake-up delivery. The temporary
MySQL instance and SQLite Docker volume are removed after testing. Operational limits,
including asynchronous write durability and single-instance ownership, are documented in
[push storage](push-storage.md).
