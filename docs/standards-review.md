# SIP standards review

Reviewed 27 October 2026. Docker label discovery and all SIP/push processing remain in
TypeScript. SIPRelay now has a stateful transaction layer, TCP transport and transparent
Path registration. **It is not yet a fully conformant general-purpose SIP or RFC 8599 proxy.**
The remaining gates below distinguish implemented behavior from unverified interoperability.

## Implemented and regression-tested behavior

- [RFC 3261](https://www.rfc-editor.org/rfc/rfc3261) client/server transactions: UDP request
  retransmissions, provisional/final response replay, bounded routing wait, local Trying,
  hop-local failure ACK and CANCEL, duplicate suppression, response identity checks and
  transport failure cleanup. INVITE timers A/B/C/D/G/H/I and non-INVITE E/F/J/K are exercised.
  CANCEL received during push or connection setup prevents later INVITE release.
- [RFC 6026](https://www.rfc-editor.org/rfc/rfc6026) Accepted client/server states retain
  success transactions through M/L, forward repeated/forked 2xx and absorb repeated INVITEs.
  [RFC 4320](https://www.rfc-editor.org/rfc/rfc4320) non-INVITE timeouts do not synthesize 408.
  These tests implement selected state-machine requirements, not independent certification.
- [RFC 3327](https://www.rfc-editor.org/rfc/rfc3327) Path mode preserves REGISTER Contact,
  prepends Path, adds Require:path and requires Supported:path on binding registrations
  (421 otherwise). Queries and wildcard removal do not add a new Path. Accepted Contacts
  have separate bindings/lifetimes. Authenticated route tokens identify the tenant, account
  and transport flow; forged/wrong-flow routes fail, missing token bindings receive 430.
  Tokens are signed, readable, process-scoped handles; they are not anonymous PURRs or GRUUs.
- UDP, plain TCP and TLS transport listeners. Stream framing preserves arbitrary body octets,
  limits frames and handles fragmented double-CRLF ping / single-CRLF pong. The keepalive is
  part of [RFC 5626](https://www.rfc-editor.org/rfc/rfc5626); full SIP Outbound is not advertised.
- [RFC 3581](https://www.rfc-editor.org/rfc/rfc3581) rport responses use the actual UDP source
  port. Without rport, responses use Via sent-by/default port. Multicast/maddr is outside
  the deployment profile.
- Compact header aliases, legal folding/horizontal whitespace, numeric CSeq identity,
  case-sensitive extension methods, Proxy-Require 420/Unsupported, bad URI 416, malformed
  hop/options 400 and hop exhaustion 483. ACK receives no locally generated response.
  Quoted address extension parameters, including +sip.instance URNs, are accepted while
  quoted/duplicate/malformed dialog tags are rejected.
- [RFC 5630](https://www.rfc-editor.org/rfc/rfc5630) secure routing intent is preserved and
  SIPS is rejected on UDP/plain TCP. TLS has a 1.2 minimum, consistent with
  [RFC 8996](https://www.rfc-editor.org/rfc/rfc8996). Optional `sip-proxy-tls-server-name`
  and `SIP_TLS_CA_PATH` separate the PBX certificate DNS identity/trust root from Docker IP.
  Node's certificate validation must stay enabled. This does not implement the complete
  [RFC 5922](https://www.rfc-editor.org/rfc/rfc5922) SIP-domain certificate matching rules.
- Our app's APNs/FCM integration defers initial INVITE delivery until an accepted REGISTER
  for the same tenant, user and push destination. A different device cannot release the call.
  A disconnected stream is allowed to enter the wake flow. A late provider callback cannot
  send a response after its transaction expires. Provider parameter parsing follows the
  supported subset of [RFC 8599](https://www.rfc-editor.org/rfc/rfc8599).

`TransactionLayer.test.ts`, `PathRegistration.test.ts`, `TcpProxy.test.ts`,
`SipUri.test.ts` and `RfcCompliance.test.ts` cover these changes alongside the transport,
registration, push and security regression suites.

## Configuration migration

`SIP_REGISTRATION_MODE=path` is the new default. Configure UA `Supported: path` and
registrar Path support (Asterisk PJSIP `support_path=yes`). Existing deployments may use
`SIP_REGISTRATION_MODE=contact` while migrating; that mode keeps legacy Contact rewriting
and account restrictions. Verify the registrar echoes/stores Path and actually returns it
in Route on requests to each Contact. Unit tests use simulated registrar responses.

TCP defaults to UDP enablement on port 5060; existing UDP-disabled deployments keep it
disabled unless explicitly enabled. TLS-only deployments should explicitly set both
`SIP_UDP_ENABLED=0` and `SIP_TCP_ENABLED=0` and remove their public port publications.
Restarting loses live connections and dialogs. Optional [push persistence](push-storage.md) retains unexpired push bindings and signed route identity; restored devices require fresh accepted registration before call delivery.

## Remaining conformance gates

1. **Live interoperability and fault injection.** Run a configured PBX, SIPp and real UAs,
   with captures under loss/duplication/reordering. Validate timer behavior, challenged
   registration, Path echo/routing, forks, early media/PRACK, busy ACK, long ringing,
   CANCEL/answer races, re-INVITE/hold/transfers and mobile wake. The isolated
   [izPBX lab](../examples/izpbx-lab/README.md) is prepared; live UDP/TCP/TLS results are recorded in [the interoperability report](interop-results.md).
2. **Full Outbound and transport routing.** reg-id/+sip.instance registration semantics,
   negotiated `outbound`/`ob`, UDP STUN keepalive, multi-flow failover, general strict/loose
   route sets, UDP-to-reliable fallback for large packets, cross-transport phone delivery,
   IPv6 UDP and [RFC 3263](https://www.rfc-editor.org/rfc/rfc3263) NAPTR/SRV failover remain.
   Parsing instance parameters and signing Path tokens do not establish Outbound support.
3. **Full push negotiation.** RFC 8599 Feature-Caps/provider discovery, scheduled binding
   refresh, standalone MESSAGE/SUBSCRIBE queues, upstream push coordination, registrar
   failure propagation and privacy-preserving PURR lifecycle are incomplete. Token rotation
   does not automatically migrate pending calls to a different push destination. The current
   implementation targets our app; do not advertise full RFC 8599 support to arbitrary UAs.
4. **Dialog/subscription breadth.** [RFC 6665](https://www.rfc-editor.org/rfc/rfc6665) early
   NOTIFY can precede the response which creates local dialog state. That path, advanced
   transfer/fork interactions and flow migration need further modeling and integration tests.
   In-memory dialogs remain pinned to their original phone flow.
5. **Syntax/security breadth.** Run the published [RFC 4475](https://www.rfc-editor.org/rfc/rfc4475)
   corpus and expand the currently restricted SIP URI/route grammar. Malformed mandatory
   input may be dropped/close the stream rather than return a specific SIP error. Full
   SIPS Contact/domain policies and authenticated inbound PBX TLS identities remain work.
   WebSocket/SCTP are not supported; they are outside the current deployment profile.

## Endpoint and media responsibilities

Digest challenges and Authorization pass through; the PBX authenticates and authorizes users
and selects digest algorithms ([RFC 8760](https://www.rfc-editor.org/rfc/rfc8760)). PRACK/RAck
pass through established early dialogs; endpoints implement [RFC 3262](https://www.rfc-editor.org/rfc/rfc3262)
reliable provisional negotiation. Bodies are opaque: SDP offer/answer and RTP encryption/NAT
are endpoint or external media relay responsibilities ([RFC 3264](https://www.rfc-editor.org/rfc/rfc3264),
[RFC 8866](https://www.rfc-editor.org/rfc/rfc8866)). SIPRelay does not relay media.

See [testing](testing.md) for the measured validation snapshot and
[security](security-review.md) for deployment requirements. High unit coverage is not a
standards certification or proof of production readiness.

## Validation snapshot

455 tests across 28 files pass; production/test type checks and build pass. Coverage is
99.05% statements, 94.82% branches, 100% functions and 99.69% lines. All original thresholds
pass unchanged. Compose validation, shell syntax checks, container builds and live UDP/TCP/TLS PBX scenarios pass.
See [the live report](interop-results.md). SIPp and physical mobile tests remain unperformed.
