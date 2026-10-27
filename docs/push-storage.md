# Push device storage

Set `PUSH_STORAGE=memory|sqlite|mysql`. The default is `memory`, preserving the existing
process-only deployment. Docker label discovery still owns PBX routing; this database does
not provision SIP accounts or replace PBX authentication.

The storage interface has three adapters. RegistrationStore owns accepted registration state,
DeviceWriter batches and coalesces changes, and adapters own database I/O. Each device's
latest change replaces queued intermediate changes, so a slow database does not create a queue
entry for every refresh. Database statements use bound parameters and batches are atomic.

## SQLite

```env
PUSH_STORAGE=sqlite
PUSH_SQLITE_PATH=/data/push.sqlite
```

Mount `/data` on a persistent volume. The image creates it for the non-root app user. For bind
mounts, grant that user access beforehand. Files are created/restricted to mode `0600`; newly
created parent directories use `0700`. Existing directory permissions remain your responsibility.
SQLite uses full synchronous commits and rollback journals. Keep the database on a local disk,
not a shared network filesystem. Node 22 SQLite operations are synchronous; local disk
latency affects SIP processing. Lock waits are capped at 100 ms and failed writes retry. Use
MySQL for deployments that require database I/O to stay off the SIP event loop. Node.js 22.13+ provides the built-in SQLite API (experimental
on Node 22); no native npm install scripts are required.

## MySQL / MariaDB

```env
PUSH_STORAGE=mysql
PUSH_MYSQL_HOST=mysql.example.internal
PUSH_MYSQL_PORT=3306
PUSH_MYSQL_DATABASE=siprelay
PUSH_MYSQL_USER=siprelay
PUSH_MYSQL_PASSWORD=replace-with-a-secret
PUSH_MYSQL_TLS=1
# Optional private CA; otherwise system trust is used:
PUSH_MYSQL_CA_PATH=/run/secrets/mysql-ca.crt
```

Create a dedicated database and restricted user first. The adapter creates two InnoDB tables,
`siprelay_push_meta` and `siprelay_push_devices`; the account needs CREATE, SELECT, INSERT,
UPDATE and DELETE privileges on that database. TLS is enabled by default, requires TLS 1.2+
and verifies the certificate and hostname. With TLS enabled, use a DNS hostname (including
`localhost`), rather than an IP literal: mysql2 uses DNS SNI for its identity check. Configuration
rejects IP literals in this mode to avoid incomplete identity verification. Connection and SQL inactivity timeouts are five seconds. `PUSH_MYSQL_TLS=0` is available for a private local
lab. Use a secret injection mechanism for the password; do not commit a real `.env`.

## Recovery and limits

Only accepted push-capable device registrations are saved: tenant, SIP user, binding identifier
(which may contain a Contact URI), transport, provider/app/token, expiry and signed route
handle. The private route signing key is also retained so a PBX's existing Path route still
resolves after restart. Sockets, source network addresses and SIP authentication headers are
not saved. Provider credentials remain in their configured secret files.

After restart, unexpired saved devices are **dormant**. Incoming initial INVITEs can trigger
push, but delivery waits for a new PBX-accepted REGISTER. No traffic goes to a stale saved UDP
address or an old stream connection. Unsupported/missing push providers cannot make dormant
devices reachable. Original registrar expiry is preserved: stored tokens do not extend it.
Expired devices are removed on startup and during normal registration-store expiry cleanup.
Refreshes update tokens; loss of push support and unregister remove saved device data.
Restoring records does not emit registration events or release waiting calls.

Startup waits for storage and fails if it is unavailable, corrupt, or contains an invalid
signed route identity. It never silently switches backends. Live SIP registration processing
uses asynchronous, ordered persistence: a success response is **not** a database durability
barrier. An abrupt crash or database outage can lose the most recent changes, including an
unregister. Pending writes retry every second; errors are logged without SQL parameters or
credentials. `GET /api/ready` returns 503 after a write failure until a write succeeds;
`/api/health` remains liveness. Idle database failures become visible when the next operation
fails. SIGINT/SIGTERM flush pending writes and close the backend, with a ten-second deadline.
Monitor readiness and stop/recover the relay if persistence cannot catch up.

A database or SQLite file belongs to **one running SIPRelay instance**. Shared MySQL storage
does not provide clustering, shared call state or failover routing. Dialogs, transactions,
held INVITEs and live connections remain in memory and do not survive restart. Changing
backends does not migrate records; clients must register again. Preserve the stable advertised
relay address/ports when recovering. Back up the signing key and device table together.

Treat the database and backups as sensitive: push tokens and the route signing key are stored
in plaintext within storage protected by filesystem/database access controls. Use encrypted
disks/backups where required. Database access is part of the relay's trust boundary; compromise
of its signing key undermines route integrity. Removing the database requires clients to
register again and invalidates old signed routes.

See [validation results](push-storage-results.md) and [repeatable checks](testing.md).
