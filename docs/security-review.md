# SIPRelay security review

Reviewed 27 October 2026. This is a source review with automated attack regressions, not an
independent penetration test or a guarantee that a deployment is secure. Docker label discovery
and native TypeScript SIP/push handling are retained.

## Patched findings

| Finding | Protection added |
| --- | --- |
| A phone could send dialog-control requests without proving it owned the observed call. | Pin dialog tags, Call-ID and tenant to the original TLS socket or UDP endpoint. Reject unknown/wrong-flow BYE, REFER, UPDATE, INFO, PRACK, NOTIFY and ACK. Match CANCEL to the original INVITE transaction and flow. |
| Predictable relay branches allowed transaction identities to be calculated from request fields. | Generate branches with a process-local random HMAC secret, including tenant and connection identity. Retransmissions and CANCEL retain the appropriate branch. |
| Response matching could tolerate missing transport metadata or different dialog tags. | Require the expected PBX endpoint/socket, relay branch, transaction identity and request tags. Ignore data from replaced upstream TLS sockets. Invalid responses cannot refresh transaction lifetime. |
| Quoted display names could be mistaken for actual SIP addresses, including during Contact rewriting. | Parse actual name-address URIs, preserve display names, and reject malformed addresses, duplicate tags, ambiguous Via branches and control characters. Push metadata and restored request targets use the same URI selector. |
| Contact rewriting could register a different routing username than the authenticated account. | Require REGISTER target domain, To account and Contact username to agree; permit registrar queries and explicit wildcard unregister. |
| Client Route/Record-Route injection could introduce an attacker-controlled hop. | Reject client Record-Route and foreign/multiple Route hops. Only a single loose Route pointing to the relay is accepted. |
| A PBX route fallback could select another known tenant or guess a tenant on a shared endpoint. | Fail closed on known-tenant endpoint mismatches and ambiguous fallback routes. |
| Unbounded transaction/connection creation and stalled TLS handshakes could exhaust resources. | Bound transaction, pending-registration, dialog and accepted-connection state; limit ingress work; enforce TLS handshake and socket idle timeouts. |
| Runtime image included development tools with known advisories; production dependencies also had advisories. | Update locked dependencies, Dockerode and Vitest; use Node 22, reproducible npm ci and production-only runtime dependencies. Remove unused Docker CLI and exclude credentials from build context. |
| Example dashboard publication exposed internal route information on every host interface. | Bind the root Compose HTTP publication to host loopback. Keep HTML escaping enabled and disable the Express version header. |

The dependency audit covers both production and development packages. A zero-advisory result
only means no advisories were reported by npm at the time of the check; it does not audit the
base operating-system image or prove absence of vulnerabilities.

## Validation

- 348 tests pass, including the new attack regressions.
- V8 coverage: 99.60% lines, 99.00% statements, 94.54% branches and 99.66% functions.
  Existing coverage thresholds pass without reductions.
- Production/test type checks, application build and Compose configuration validation pass.
- `npm audit` reports zero known vulnerabilities, including development dependencies.
- The Docker image build and live PBX/mobile interoperability remain unverified here.

## Deployment requirements for call protection

1. **Authenticate and authorize at the PBX.** SIPRelay is a proxy, not a credential verifier.
   The PBX must challenge REGISTER and initial call requests and authorize the authenticated
   identity to register the exact To account and make the requested call. Disable anonymous
   calling, guest registration and inappropriate transfer/dial permissions. Forwarding a request
   to a discovered PBX does not authenticate its caller. Rate limits do not replace brute-force
   protection, strong credentials, account lockouts or toll-fraud controls at the PBX.
2. **Use TLS on public phone connections.** Set `SIP_UDP_ENABLED=0` and `SIP_TCP_ENABLED=0`, and remove/block public
   UDP and plain TCP 5060 when using TLS-only signalling. Supply a valid relay certificate and have the mobile
   app validate its hostname and trust chain. Do not set `SIP_TLS_REJECT_UNAUTHORIZED=0` in
   production. PBX certificates must validate for the endpoint used by SIPRelay. TLS minimum
   version is 1.2. UDP flow checks use address/port; an on-path attacker or a packet spoofing
   those values is outside their protection. Signalling over UDP remains readable and mutable.
3. **Require encrypted media in the phones and PBX.** TLS protects SIP signalling, not RTP.
   This service passes SDP through and does not relay or encrypt media. Configure and verify
   SRTP/DTLS-SRTP with authenticated key negotiation on the actual endpoints. Check that
   fallback to clear RTP is prohibited. SIPRelay cannot enforce this end-to-end requirement.
4. **Isolate PBX and Docker networks.** Backend identity relies on discovered endpoint identity
   and, on outgoing TLS connections, certificate validation. Inbound PBX TLS connections are
   recognized by discovered source IP; client certificates are not required. These connections
   are suitable only on a trusted, isolated backend network. Do not expose PBX ports or allow
   untrusted containers/hosts to impersonate discovered PBXs. Tenants sharing an actual PBX
   endpoint require authorization inside that PBX; endpoint matching is not tenant authentication.
5. **Treat Docker discovery as privileged configuration.** Anyone able to launch/label containers
   can influence routes. A Docker socket mounted `:ro` still permits privileged Docker API calls;
   read-only filesystem mounting does not restrict HTTP methods on the socket. Prefer an
   authenticated, isolated Docker API proxy/authorization layer restricted to the list, inspect
   and event operations needed by the watcher. Do not expose that proxy publicly. Protect the
   host daemon and restrict who can set the discovery labels.
6. **Keep HTTP administration private.** The dashboard and GET API have no built-in authentication.
   The root Compose file publishes them on `127.0.0.1:8080`; other deployments and internal
   container networks must provide equivalent restrictions. A public reverse proxy must add
   authentication and TLS. CORS is not access control.
7. **Protect push keys and device tokens.** Mount APNs/FCM credentials as restricted secrets,
   keep them out of images/source control and rotate them when needed. Push registration is
   accepted only following a matching successful PBX REGISTER response. The PBX must enforce
   the account authorization described above. The mobile app must treat a push as a wake hint,
   reconnect with certificate validation and authenticate before accepting a SIP call.

## Operational limits and compatibility

- Live call state is in memory. Optional [push persistence](push-storage.md) stores sensitive tokens and the private route signing key behind filesystem/database access controls. A restart loses dialogs and pending transactions. Requests for old dialogs
  then fail closed; deploy with draining rather than assuming calls survive relay restarts.
- Active dialogs are pinned to the original socket/UDP endpoint. A new TLS connection or NAT
  rebinding does not take over an existing dialog. Cross-transport delivery and arbitrary
  multi-hop client Route sets are unsupported. Path mode preserves multiple Contacts and uses signed per-flow routing. Legacy Contact mode
  retains the single Contact/account username restriction. Test each configured mode against
  the supported mobile app and PBX.
- Each proxy limits ingress to 2,000 work units/second total and 200/source IP/second in fixed
  windows. UDP datagrams count once; TLS chunks and decoded messages each count once. Excess
  UDP is dropped; excess TLS closes the connection. Shared-NAT users and busy PBXs share a
  per-IP budget. These are conservative hardcoded limits: load-test expected traffic and tune
  before deployment. They are not protection against a network-saturating DDoS.
- Transaction lifetimes now follow per-state SIP timers; routing/push waits remain bounded. Pending registrations expire after their
  service timeout. Dialog state has a 24-hour idle lifetime (shorter for failed/early dialogs).
  Tables cap at 10,000 entries each. Accepted TLS connections cap at 2,000, handshakes at
  10 seconds and incoming socket inactivity at 60 seconds. Configure appropriate SIP CRLF
  keepalives in connected clients/PBXs. Upstream TLS has an independent five-minute idle timer.
- Validate actual Asterisk/PBX challenge flows, incoming/outgoing calls, CANCEL, busy responses,
  early media/PRACK, hold/re-INVITE, transfers, mobile wake/re-registration and media encryption
  in staging. Automated tests use fake sockets/providers; they do not establish interoperability
  or validate live APNs/FCM delivery. The isolated lab image now builds and live UDP/TCP/verified-TLS scenarios pass; see
  [the interoperability report](interop-results.md). Physical mobile/provider checks remain pending.

## References

- [SIP transaction, dialog and security definitions (RFC 3261)](https://www.rfc-editor.org/rfc/rfc3261.html)
- [Docker daemon access protection](https://docs.docker.com/engine/security/protect-access/)
- [Dockerode releases](https://github.com/apocas/dockerode/releases)
- [Vitest migration documentation](https://vitest.dev/guide/migration/)

The subsequent transaction/Path/TCP pass passes 455 tests and the unchanged coverage gates,
with type checks and build passing. See [the current standards review](standards-review.md)
for implementation limits; the earlier test counts above describe the historical security pass.
