# Local izPBX signalling lab

This dedicated Compose project uses izPBX 20.16.22 (actual tested engine: Asterisk 20.21.0)
and MariaDB 10.11.19. It has separate volumes, a private bridge and loopback-only published
ports. No database or PBX SIP ports are published. SIPRelay keeps Docker label discovery.
The relay's Docker API mount grants privileged Docker access: use a trusted local host.

The provisioning script verifies the PBX's Compose project identity, creates random passwords
for lab extensions 9001/9002 and installs dedicated custom SIP/dialplan includes. These
extensions can call only each other. It preserves other custom includes and does not configure
trunks, inbound routes or public calling. FreePBX's admin setup can be completed separately;
it is not required for the script's direct SIP configuration. Passwords stay in the ignored,
mode-0600 `.lab-credentials.json`; never commit or display it.

## Run UDP and TCP checks

Use Node.js 22.12+ and Docker access. From this directory:

```bash
./prepare.sh
docker compose config --quiet
docker compose up --build -d
node provision.cjs
node interop.cjs
node interop.cjs --tcp
```

The helper waits up to 60 seconds for Asterisk. The probe waits up to 15 seconds for relay
HTTP/discovery readiness and uses bounded SIP waits. It is an independent wire-level client:
it does not import SIPRelay's parser. Only test methods/statuses are printed, never passwords
or Authorization headers. `LAB_TRACE=1 node interop.cjs` adds method/status/CSeq traces.

The scenarios cover challenged REGISTER and Path echo, refresh/query, duplicate registration
replay, INVITE/180/200/ACK, both call directions, caller/callee BYE, busy/486/failure ACK,
CANCEL/200/487, deliberately withheld ACKs and resulting response retransmissions, multiple Contacts and selective unregister. They also send a forged answer
and stolen-dialog BYE from a different flow and require rejection. Test Contacts deliberately
use `phone.invalid` and opaque device usernames: delivery must follow the authenticated Path,
not DNS or account-name Contact rewriting. Registrations are removed on success and on failure.

## Verified TLS checks

```bash
./prepare-tls.sh
docker compose -f compose.yml -f compose.tls.yml up -d pbx siprelay
node provision.cjs --tls
node interop.cjs --tls
```

The profile adds upstream TLS discovery/SNI (`pbx.test`), a trusted lab CA and relay TLS on
15061. Short-lived certificates identify `pbx.test` and `siprelay.test`; the relay certificate
also identifies its bridge IP. Node validates the relay certificate; SIPRelay validates the
PBX certificate against the lab CA and configured DNS identity. Verification remains enabled.
The probe additionally requires rejection of a mismatched relay certificate name and an
untrusted relay CA. The separate upstream-negative mode expects 503 when the configured
PBX certificate identity is deliberately wrong; restore the default afterwards.

The CA private key stays on the host; only leaf keys/certificates and the public CA are copied
into the lab containers with restricted ownership. `.tls/` is gitignored and excluded from
Docker builds. Certificates expire after two days; to generate replacements, intentionally
remove this lab's `.tls/` and rerun preparation. Recreating the relay discards its copied leaf
credentials: rerun `node provision.cjs --tls` afterwards. When TLS is enabled, use `--tls`
when reprovisioning so its PBX transport remains configured.

## Addresses and manual UAs

This profile targets native Docker on Linux. The advertised relay bridge address
`172.30.231.10` is reachable by both the PBX and local host UAs. Advertising 127.0.0.1
in Path would route PBX calls into the PBX's own loopback. If subnet `172.30.231.0/24`
conflicts with a local network, update IPAM, PROXY_IP, relay address, probe addresses and
certificate IP SAN together before starting.

The relay uses the same advertised and published SIP port: 15060 for UDP/TCP, 15061 for TLS.
The PBX registrar has `support_path=yes` on each lab AoR and `rewrite_contact=no` on endpoints,
consistent with [Asterisk's Path configuration](https://docs.asterisk.org/Latest_API/API_Documentation/Module_Configuration/res_pjsip/#support_path).
UAs advertise `Supported: path`. The relay runs `SIP_REGISTRATION_MODE=path`.

FreePBX is at http://127.0.0.1:18081 and discovery at http://127.0.0.1:18080/api/routes.
For manual phones, provision separate extensions through FreePBX, preserving the scripted
9001/9002 test accounts. Point local UAs at the relay with SIP domain `pbx.test`. No inbound
routes/trunks are needed for the internal test dialplan. Do not attach production networks.

## Limits and cleanup

See [the live test report](../../docs/interop-results.md) for measured results and image IDs.
These are real signalling exchanges against a local PBX, not a general SIP conformance suite.
No RTP/audio quality, external trunk/PSTN, physical mobile/APNs/FCM, load/soak or packet-loss
matrix is certified by these probes. Media testing needs a reachable RTP topology/media relay.
Fail2ban is disabled so this loopback-only lab needs no privileged mode/firewall capabilities.

```bash
docker compose down
```

This retains lab volumes. `docker compose down --volumes` destroys this lab's PBX/database
state; use it only for an intentional reset. No production volumes are used.

## Two-PBX routing checks

The second-PBX overlay adds `pbx-b.test` at http://127.0.0.1:18082 with its own database/PBX
containers and volumes. It deliberately reuses extension numbers 9001/9002 with different SIP
passwords, enabling tests of domain routing and tenant separation. This is a local lab; database
bootstrap credentials are shared by its two separately stored databases.

```bash
./prepare-tls.sh
docker compose -f compose.yml -f compose.tls.yml -f compose.two-pbx.yml up -d
node provision.cjs --tls
node provision.cjs --second --tls
node multi-pbx.cjs
node multi-pbx.cjs --tcp
node multi-pbx.cjs --tls
node multi-pbx.cjs --lifecycle
```

`prepare-tls.sh` keeps the existing lab CA and existing leaf certificates and creates missing
ones, including the distinct `pbx-b.test` certificate. The second PBX has its own ignored
`.lab-credentials-b.json`. A fresh FreePBX installation may not have generated its configuration
includes yet; provisioning uses `fwconsole reload` once if needed, before installing its
custom test includes. Inbound routes/trunks and another admin wizard are unnecessary for these
internal calls. Provisioning the second tenant does not restart the first PBX or relay.

The matrix uses simultaneous calls with matching Call-IDs, checks the actual originating PBX
and exact Contact, rejects wrong-tenant credentials/stolen routes and sends a forged foreign
flow-token request from PBX B itself. `--lifecycle` stops only PBX B, checks continued service
on A and absence of fallback, then restarts B and checks rediscovery/calls. It leaves both
PBXs running and removes its test registrations. These are signalling/routing checks, not a
mutually untrusted Docker-host security certification. See [the two-PBX results](../../docs/multi-pbx-results.md).

Use all three Compose files together when managing the complete lab, including cleanup:

```bash
docker compose -f compose.yml -f compose.tls.yml -f compose.two-pbx.yml down
```

Named volumes remain unless explicitly deleted. Do not add `--volumes` unless intentionally
resetting the lab's PBX and database data.
