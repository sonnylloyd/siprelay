# Application structure

Docker labels remain the routing control plane. SIP and push processing remain TypeScript.
The refactor separates protocol decisions from provider and transport I/O while preserving the mobile app payload contract. Path registration and TCP add explicit
configuration choices, described in the README.

## Dependency composition

`src/container.ts` is the composition root: it selects the memory route store, Docker watcher,
transport proxies, configured push providers and the selected push storage adapter. Its dependency interface checks service names
and construction arguments. Services receive dependencies through constructors rather than
looking them up in the container. TLS construction stays lazy because certificates are optional.

`ProxyInitializer` depends on the small `Proxy` interface. UDP accepts a minimal transport
interface and an options object, so tests can supply a fake socket without casting a fake
into Node's complete socket API. DockerWatcher also accepts an optional Docker client.

The single-implementation route-store and watcher factories were removed: implementation
selection belongs in the composition root until additional implementations actually exist.

## SIP responsibilities

- `SipMessage`: message validation, metadata and header mutations.
- `SipHeaderNames`: case-insensitive and compact header names; safe extension-name lookup.
- `SipUri`: address extraction and IPv6 host formatting shared by parsing and forwarding.
- `SipFrameDecoder`: byte-oriented stream boundaries, size limits and length validation.
- `PbxRouteResolver`: selecting a Docker tenant and verifying the PBX endpoint. A claimed
  Route must match its source; it cannot fall back to a different tenant.
- `BaseProxy`: common forwarding headers, transport identities and response-routing mappings.
- `TransactionLayer`: network-independent client/server state machines, retransmission/timer
  ownership and hop-local ACK/CANCEL. Transport callbacks retain the original response flow.
- `UdpProxy` / `StreamProxy`: transport I/O, response validation and delivery on the correct flow.
  `TcpProxy` and `TlsProxy` force their respective transport while sharing stream framing,
  connection pooling and registration behavior. Each transport currently owns its transaction
  and dialog state; cross-transport delivery is not implemented.
- `RegistrationStore` / `FlowTokenCodec`: multiple accepted Contact bindings and signed Path
  route handles. These tokens authenticate routing metadata without claiming anonymity.
- `RegistrationService`: track a forwarded REGISTER and apply its accepted result. Final
  responses clear pending state through one cleanup path; provisional responses retain it.

Media stays passthrough. The dormant SDP-rewriting method and its two dependencies were removed.

## Push provider strategies

`PushSender` is the coordinator-facing interface. `PushService` chooses a configured
`PushProvider` strategy; APNs and FCM each own their authentication, token cache and network
requests. Common JWT signing and incoming-call payload construction are separate pure helpers.
Device push parameters are parsed independently from provider configuration and I/O.

To add a provider, implement `PushProvider`, validate its configured credentials, and register
it in `PushService`. Extend the provider identifier and Contact parsing rules deliberately.
The coordinator should not need provider-specific conditionals.

## Pending call state

`PushCoordinator` has four explicit states: waiting, resuming, released and failed. Its
TypeScript union requires failed states to carry their status and reason. Named transition
methods handle registration, replay, rejection and expiration; timers remove entries by key.

Transport proxies call `handleRequest` with named delivery/response callbacks. ACK suppression,
CANCEL handling and INVITE deferral therefore use the same policy across transports.
Delivery waits for a microtask so REGISTER 200 is written first; cancellation can still stop
that transition. `dispose()` detaches the registration listener, clears timers and prevents
late provider results or deferred callbacks from reviving disposed calls.

## Validation

Run `npm run typecheck`, `npm run build` and `npm test` after changes. Production compilation
checks unused declarations and consistent filename casing. A separate test TypeScript project
also checks fake transports and mocks, which Vitest's transpilation alone does not do.

Tests exercise observable behavior: trusted endpoint selection, SIP forwarding, registration
refresh, provider wire formats/signatures, pending-call races, replay and cleanup. The
[protocol review](flexisip-review.md) records the remaining interoperability and deployment limits.

## Push persistence

`PushStorage` separates memory, SQLite and MySQL adapters from registration processing.
`DeviceWriter` coalesces per-device changes, serializes transactional batches, retries failures
and exposes storage health. Startup restores the signing key and unexpired bindings before
listeners open. Restored bindings are dormant and require a fresh accepted registration to
become deliverable. See [storage and recovery](push-storage.md), including the asynchronous
write durability window and single-instance deployment requirement.
