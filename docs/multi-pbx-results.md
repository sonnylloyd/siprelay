# Two-PBX routing and tenant isolation checks

Run on 27 October 2026 in the isolated `siprelay-izpbx-lab` Docker project. Both PBXs use
`izdock/izpbx-asterisk:20.16.22` (Asterisk 20.21.0), separate database/PBX containers and
separate named data volumes. The existing first PBX's administrator configuration is preserved.
No production containers or external trunks were used.

| Docker service | SIP domain label | SIP ports | Expected TLS identity | Local admin URL |
| --- | --- | --- | --- | --- |
| pbx | pbx.test | UDP/TCP 5060, TLS 5061 | pbx.test | http://127.0.0.1:18081 |
| pbx-b | pbx-b.test | UDP/TCP 5060, TLS 5061 | pbx-b.test | http://127.0.0.1:18082 |

Both PBXs intentionally have extensions **9001 and 9002**, with different random SIP passwords
on each PBX. The relay must select by domain and authenticated flow, not extension or port
alone. Dialplan markers identify the PBX that actually originated each delivered INVITE;
the independent test client verifies both that marker and the exact intended device Contact.

## Live results

| Check | UDP | TCP | Verified TLS |
| --- | --- | --- | --- |
| Both label-defined domains discovered at distinct PBX IPs, with equal ports | Pass | Pass | Pass |
| Same extension numbers register independently | Pass | Pass | Pass |
| Identical registration Call-ID/CSeq remain isolated | Pass | Pass | Pass |
| Concurrent calls sharing a Call-ID reach the correct PBX and device | Pass | Pass | Pass |
| PBX A credentials cannot register on PBX B | Pass | Pass | Pass |
| A phone cannot steal another tenant's Path/flow token | Pass | Pass | Pass |
| PBX B cannot retarget PBX A's signed flow token to its own tenant | Pass | Pass | Pass |
| Unregistering on PBX A does not remove PBX B's binding | Pass | Pass | Pass |

The forged PBX request is sent **from inside PBX B's network namespace**, not merely from a
host test phone. UDP uses the actual configured source IP and SIP port 5060; TCP/TLS establish
connections from B. The test alters the tenant route parameter of A's signed flow handle and
requires 403 plus no delivery to A's phone. The probe prints only the response status, not
credentials or captured traffic. TLS validates the relay certificate using the lab CA.

## Docker lifecycle result

The UDP lifecycle run stopped only `pbx-b` and verified that:

1. Docker discovery removed `pbx-b.test` while retaining `pbx.test`.
2. A complete call on PBX A still succeeded while B was stopped.
3. A request targeting stopped PBX B did not get a final response from PBX A; there was no
   implicit fallback to the remaining tenant. Unknown routes currently receive no immediate
   SIP final response, so the probe explicitly expects its bounded OPTIONS wait to expire.
4. Restarting B restored its discovered route and authenticated registrations/calls.
5. PBX A's accepted registration remained intact without restarting the relay.

Calls and registrations are cleaned up after each run. The initial single-PBX scenarios and
455-test automated baseline are described in [the interoperability report](interop-results.md).
No production SIP implementation changes were required for these two-PBX checks.

## Reproduction

See [the lab instructions](../examples/izpbx-lab/README.md#two-pbx-routing-checks). New files:
`compose.two-pbx.yml` adds the second database/PBX; `multi-pbx.cjs` runs the live assertions.
The provisioning helper's `--second` mode installs separate credentials, a distinct PBX TLS
certificate and the tenant marker, without restarting the first PBX or relay.

## Scope

These checks establish observed SIP routing/flow separation in this lab; they do not certify
isolation against a compromised Docker host, spoofed network identity or arbitrary container
intrusion. PBX source network identity remains part of the relay's trust model. The databases
have separate storage but use the lab's shared bootstrap database credentials; this example
is not a production deployment model for mutually untrusted administrators. External trunk,
PSTN, media/audio, physical mobile push, large-scale load and full RFC conformance remain
outside this routing test. The UDP injection probe requires the lab container's normal
NET_RAW capability; no privileged container or additional capability was enabled.
