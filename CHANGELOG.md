# @contextvm/sdk

## 0.11.0

### Minor Changes

- a9e0433: Add CEP-41 open-ended stream transfer support over ContextVM transport.

  This introduces open-stream framing over MCP [`notifications/progress`](docs/cep-41.md:10) using the request `progressToken` as the stream identifier, with support for `start`, `accept`, `chunk`, `ping`, `pong`, `close`, and `abort` frames.

  It also adds SDK support for:
  - client and server open-stream transport handling
  - stream session lifecycle management, buffering, and keepalive timeouts
  - ergonomic tool streaming via [`callToolStream()`](src/transport/call-tool-stream.ts:28)
  - CEP-41 coverage across unit and end-to-end transport tests

### Patch Changes

- cda331b: fix(transport): ensure session cleanup and proper ordering in open streams
  - Fix registry to remove sessions even when onClose/onAbort callbacks throw
  - Add queuedBytes tracking to count unread chunks against buffer limits
  - Release queued byte budget when chunks are consumed by iterator
  - Add operation queue to writer to serialize concurrent writes before close
  - Add tests for concurrent chunk/close processing and callback error handling

- 109f1dc: refactor(relay): process relay pings individually with proper cleanup

  Refactor the ping mechanism to process each relay separately instead of using a merged stream. Each relay now gets a unique ping ID and its own subscription that is properly cleaned up with a CLOSE message in a finally block. This ensures better isolation between relay pings and prevents potential race conditions when multiple relays respond.

## 0.10.0

### Minor Changes

- 864257f: Add CEP-15 common schema support for `tools/list`, including schema hash metadata for compatible tools and `i`/`k` discovery tags in public announcement events.

### Patch Changes

- 762bab0: fix(nostr): verify signatures for decrypted and unencrypted events and dedupe inner event ids

## 0.9.1

### Patch Changes

- 1737128: refactor(relay): make getRelayUrls required in RelayHandler interface

  Changed getRelayUrls from optional to required method in RelayHandler interface.
  Updated mock implementation and removed optional chaining in transport layer.

- 8137fd4: fix(transport): deduplicate decrypted inner events before processing
- 570de79: Fix stale timestamp in queued NWC requests by capturing `nowSeconds()` inside the `run()` closure so the `created_at` field reflects when the event is actually built and signed, not when it was enqueued.
- 9e3667d: Fix NWC relay subscriptions not being cleaned up when a request times out by moving the `.finally()` cleanup onto the `withTimeout()` promise instead of the inner promise, so the subscription is closed regardless of whether the timeout or the relay response wins the race.
- c8f44dd: fix(payments): drop uncorrelated payment_required notifications on Nostr transports
- 22c311a: fix(transport): drop correlated notifications with unknown e-tag
- b408930: feat(transport): expose inbound Nostr request event id in MCP requests

  Add support for injecting and accessing the inbound Nostr request event ID in MCP request messages via the \_meta field. This enables middleware and tools to access the original Nostr event that triggered the request, including the event's pubkey and full event data through a request-scoped context store.

- 5f773a2: fix(transport): recover response route after publish failure
- 523a474: refactor(transport): stop merging later response tags into learned server discovery baseline

## 0.9.0

### Minor Changes

- 8f70313: feat(transport): add optional NIP-01 kind:0 profile metadata publication (CEP-23) for `NostrServerTransport`.

  Also improves discoverability relay publication behavior in local/non-websocket relay environments and stabilizes related transport tests.

### Patch Changes

- 89d58f0: fix(transport): make discoverability relay publication deterministic for local and memory relay environments.
  - Skip default bootstrap relays when operational relays are local/memory and no explicit bootstrap list is configured.
  - Fallback to direct publish when discoverability targets are non-websocket relay URLs.
  - Stabilize oversized transfer event assertions and add focused announcement manager coverage for relay target selection.

- 9eba731: feat(transport): simplify NostrSigner initialization to accept hex string
- 5736ad2: Post-merge cleanup for #35 (oversized-payloads). Extracts focused submodules from the two largest
  transport files without changing any public API or behavior.

## 0.8.0

### Minor Changes

- ddcfba8: Add oversized payload transfer support for the Nostr transport layer.

  This prerelease includes the new oversized transfer protocol, sender and
  receiver flows, sequencing and out-of-order chunk handling, and UTF-8-safe
  chunk splitting improvements for large payload delivery.

### Patch Changes

- a0562ab: refactor(transport): extract outbound tag composition into base class

  Extract the logic for composing outbound Nostr tags into a reusable
  `composeOutboundTags` method in BaseNostrTransport. This standardizes
  tag ordering across client and server transports (base tags first,
  then discovery tags, then negotiation tags).

  Refactor NostrClientTransport and NostrServerTransport to use the
  shared composition method, and add `chooseServerOutboundGiftWrapKind`

- a0562ab: refactor(transport): extract discovery tags into dedicated module and add client capability advertisement

  Extract discovery tag parsing and merging logic into a new discovery-tags.ts module. Add client-side capability advertisement so clients can proactively advertise support for encryption, ephemeral gift wraps, and oversized transfers without waiting for server discovery. Also fix a race condition in the oversized transfer receiver where accept could arrive before waiter registration.

  BREAKING CHANGE: The hasKnownDiscoveryTag function has been removed from nostr-client-transport.ts in favor of the new hasDiscoveryTags and parseDiscoveredPeerCapabilities functions.

## 0.8.0-next.2

### Patch Changes

- refactor(transport): extract outbound tag composition into base class

  Extract the logic for composing outbound Nostr tags into a reusable
  `composeOutboundTags` method in BaseNostrTransport. This standardizes
  tag ordering across client and server transports (base tags first,
  then discovery tags, then negotiation tags).

  Refactor NostrClientTransport and NostrServerTransport to use the
  shared composition method, and add `chooseServerOutboundGiftWrapKind`

## 0.8.0-next.1

### Patch Changes

- refactor(transport): extract discovery tags into dedicated module and add client capability advertisement

  Extract discovery tag parsing and merging logic into a new discovery-tags.ts module. Add client-side capability advertisement so clients can proactively advertise support for encryption, ephemeral gift wraps, and oversized transfers without waiting for server discovery. Also fix a race condition in the oversized transfer receiver where accept could arrive before waiter registration.

  BREAKING CHANGE: The hasKnownDiscoveryTag function has been removed from nostr-client-transport.ts in favor of the new hasDiscoveryTags and parseDiscoveredPeerCapabilities functions.

## 0.8.0-next.0

### Minor Changes

- Add oversized payload transfer support for the Nostr transport layer.

  This prerelease includes the new oversized transfer protocol, sender and
  receiver flows, sequencing and out-of-order chunk handling, and UTF-8-safe
  chunk splitting improvements for large payload delivery.

## 0.7.8

### Patch Changes

- refactor: fallback is now a true parallel connection-path candidate rather than only a relay-connectivity probe.

## 0.7.7

### Patch Changes

- feat(transport): add fallback operational relays support for NostrClientTransport

Introduces a new `fallbackOperationalRelayUrls` option that provides operational relays to use when CEP-17 discovery fails to resolve any relays. These fallback relays are probed in parallel with discovery, and the first available source is used. If discovery returns no results, the fallback relays are used as a secondary option.

## 0.7.6

### Patch Changes

- 8b1ea20: feat(transport): add dynamic pubkey and capability exclusion authorization

  Add support for dynamic authorization in NostrServerTransport through two new optional callbacks: isPubkeyAllowed for runtime pubkey validation and isCapabilityExcluded for dynamic capability exclusion. These async callbacks complement the existing static allowlist and exclusion configurations, enabling more flexible authorization policies. The authorization policy methods have been made async to support these new dynamic checks.

- cd7f411: refactor(transport): rename isPublicServer to isAnnouncedServer

  Rename the `isPublicServer` option to `isAnnouncedServer` to better reflect its purpose of publishing public announcement events on Nostr for relay-based discovery. The old option is deprecated but still supported for backward compatibility.

## 0.7.5

### Patch Changes

- feat(transport): enable stateless clients to learn discovery tags from first response

Previously, stateless clients couldn't receive server discovery tags (name, about, website, picture, encryption support) because they skip the initialize handshake. This change adds logic for the server to include discovery tags in its first response to a client, and for the client to learn and store these tags from that initial response. A new test verifies this behavior works correctly.

## 0.7.4

### Patch Changes

- feat(relay): add websocket support for relay connections

  Adds the `ws` package as a dependency and implements websocket utilities to enable websocket connections in the relay pool. The new `src/core/utils/websocket.ts` module provides the `ensureWebSocket` function which is called when creating relays in `ApplesauceRelayPool`.

## 0.7.3

### Patch Changes

- feat(transport): expose server initialize event convenience accessors

## 0.7.2

### Patch Changes

- feat(nostr-client): default discovery to bootstrap relays and make relayHandler optional

## 0.7.1

### Patch Changes

- refactor(relay): downgrade publish log level to debug

## 0.7.0

### Minor Changes

- feat(transport): implement CEP-17 relay list metadata for discoverability

  Add NIP-65 relay list metadata (kind 10002) support to enable server relay discoverability. Servers can now publish their operational relays, and clients can discover them via nprofile relay hints or by querying discovery relays.

  Add RELAY_LIST_METADATA_KIND (10002) and DEFAULT_BOOTSTRAP_RELAY_URLS constants

  Add server-identity.ts to parse npub/nprofile and extract relay hints

  Add server-relay-discovery.ts to fetch and parse server relay lists

  Update NostrClientTransport to resolve operational relays from hints or discovery

  Update NostrServerTransport to publish relay list metadata for public servers

  Add tests for npub/nprofile parsing, relay discovery, and server relay list publication

## 0.6.2

### Patch Changes

- fix(payments): tighten settled invoice detection logic

## 0.6.1

### Patch Changes

- refactor(transport): capability tags on first response for stateless ephemeral discovery

## 0.6.0

### Minor Changes

- feat(core,transport): add support for ephemeral gift wraps (CEP-19 kind 21059)

  Add GiftWrapMode enum to control gift wrap kind selection:
  - OPTIONAL: accept both 1059 and 21059, select based on peer capability
  - EPHEMERAL: only accept/send 21059
  - PERSISTENT: only accept/send 1059

  Introduce EPHEMERAL_GIFT_WRAP_KIND constant (21059) and SUPPORT_ENCRYPTION_EPHEMERAL tag.
  Update encryption layer to encrypt/decrypt both gift wrap kinds.
  Modify transport subscription filters and inbound routing to handle both kinds.
  Server responses in OPTIONAL mode mirror the inbound wrap kind.

## 0.5.0

### Minor Changes

- Add client-side payment policy hook for LLM-aware payment consent
  - Added `paymentPolicy` hook to `ClientPaymentsOptions` for consent/authorization before payment execution
  - Extended `PaymentHandlerRequest` to include `pmi` field for rail identification
  - Added `OriginalRequestContext` type (`{ method, capability }`) stored in correlation store
  - `NostrClientTransport` now captures minimal request context for tools/prompts/resources
  - Both `paymentPolicy` decline and `canHandle === false` now synthesize JSON-RPC errors with code `-32000` when correlation exists (fail-fast behavior)
  - Error `data` includes `{ pmi, amount, capability, method }` for programmatic handling
  - Synthetic progress lifecycle documented: starts on `payment_required`, stops on all terminal outcomes (accept/reject/client decline)

## 0.4.14

### Patch Changes

- feat(payments): allow resolvePrice to waive payment and forward immediately

  Add ResolvePriceWaiver type and waivePrice helper to enable resolvePrice
  callbacks to signal that payment is waived, causing the middleware to
  forward the request without requiring payment verification. This supports
  use cases where payment is covered externally or dynamically determined
  to be unnecessary. Includes test coverage for the waiver flow.

## 0.4.13

### Patch Changes

- feat(payments): synthesize JSON-RPC error on payment_rejected and add default TTL

  Add support for synthesizing a JSON-RPC error response when the server sends
  payment_rejected, allowing the MCP request to fail immediately instead of
  hanging until the timeout. Also add defaultPaymentTtlMs option to keep the
  client-side request alive for the same duration the server will wait when
  the payment_required notification omits the ttl field.

  Add rejectPrice() and quotePrice() helper factories to types.ts for safer
  price resolution. Add duplicate PMI handler/processor warnings. Include ttl
  and \_meta fields in PaymentHandlerRequest for full CEP-8 transparency.

## 0.4.12

### Patch Changes

- fix(payments): ensure onmessageWithContext is own property for NostrClientTransport

## 0.4.11

### Patch Changes

- fix(payments): emit immediate synthetic progress heartbeat on payment_required receipt

## 0.4.10

### Patch Changes

- feat(payments): add synthetic progress for CEP-8 payment timeout handling

  Implements synthetic progress notifications to keep MCP requests alive during
  payment settlement, preventing upstream timeout races when CEP-8 TTL exceeds
  the default MCP request timeout.

  Transport changes:
  - B1: Fix server progress routing (params.progressToken not params.\_meta.progressToken)
  - B2: Add taskQueue.shutdown() to NostrClientTransport.close()
  - S1: Fix double lookup in getOrCreateClientSession

  Cleanup:
  - D1: Remove dead removeEventRoute from correlation-store
  - D2: Simplify processor lookup in server-payments
  - D3: Remove dead lastActivity/updateActivity from session-store
  - D4: Refactor shouldEvictSession to not re-insert inside eviction callback
  - D5: Refactor publishEvent to use shared withTimeout helper
  - S2: Remove redundant stopAllSyntheticProgress from wrapped.close()

## 0.4.9

### Patch Changes

- perf(transport): deduplicate inbound events including decrypted inner requests

## 0.4.8

### Patch Changes

- fix(transport): prevent duplicate response publishing on concurrent sends

  Add popEventRoute method to CorrelationStore that atomically retrieves and removes
  the event route, replacing the previous getEventRoute + removeEventRoute pattern.
  This ensures responses are only routed once, even when send() is called concurrently
  with the same response id, preventing duplicate publishes.

## 0.4.7

### Patch Changes

- perf(transport): deduplicate inbound gift-wrap envelopes before decryption

Add LRU-based deduplication to both NostrClientTransport and NostrServerTransport
to skip expensive decrypt operations for duplicate gift-wrap event deliveries.
This prevents redundant processing when the same gift-wrap event is received
multiple times from relays, improving throughput under high message volume.

## 0.4.6

### Patch Changes

- feat(payments): add NIP-47 notification support for payment verification

Add support for NWC notifications (NIP-47) to enable push-based payment
verification instead of polling. This includes:

- New `fetchInfoNotificationTypes()` and `subscribeNotifications()` methods
  in NwcClient to query and subscribe to wallet notifications
- New `enableNotificationVerification` option in LnBolt11NwcPaymentProcessor
  to control notification-based verification
- Auto-detection of notification support via wallet info event when option
  is undefined (best-effort mode)
- Notification-based verifyPayment that waits for payment_received events

## 0.4.5

### Patch Changes

- refactor(relay): consolidate subscription state into Map
- feat(payments): add NIP-57 Lightning Zaps support

  Implement NIP-57 Lightning Zaps for CEP-8 payment processing. This adds:
  - New `nip57/lnurl` module for LNURL-pay (LUD-16) support
  - New `nip57/zap-events` module for kind 9734/9735 zap events
  - New `LnBolt11ZapPaymentProcessor` that issues BOLT11 invoices via LNURL-pay and verifies settlement via zap receipts
  - Enhanced `LnBolt11NwcPaymentProcessor` with deduplication and caching for concurrent invoice verifications
  - New `sleepWithAbort` utility function

  Also adds documentation for NIP-57 and removes the `applesauce` submodule reference.

## 0.4.4

### Patch Changes

- fix: prevent zombie publish loops and add regression tests
  - ApplesauceRelayPool.publish() now checks abortSignal.aborted in the
    retry loop to stop infinite retries when upstream timeouts occur
  - BaseNostrTransport uses AbortController instead of withTimeout() for
    proper cancellation semantics
  - RelayHandler.subscribe() returns Promise<() => void> for per-subscription
    cleanup, fixing NWC subscription leaks
  - NwcClient.request() cleans up subscriptions on success, timeout, and error
  - Add regression tests:
    - applesauce-relay-pool.publish-abort.test.ts: unit test verifying
      publish() stops retrying when aborted
    - payments-multi-client-disconnect.e2e.test.ts: e2e test with server
      and multiple clients, some disconnecting mid-flight, ensuring
      server remains responsive (no zombie loops)

## 0.4.3

### Patch Changes

- fix: avoid global unsibscribe for nwc-client

## 0.4.2

### Patch Changes

- feat(payments): add payments exports and logging

This commit adds the payments module to the package exports, including
subpaths, making it available for import. It also adds logging to the client
and server payment flows for better observability.

## 0.4.1

### Patch Changes

- feat(transport): capture list response envelopes and attach pricing tags

  This change enables the client to access CEP-8 cap tags (pricing) from list responses without fetching announcement events.

  The server now attaches pricing tags to list responses, and the client captures the event envelopes to expose them. This allows consumers to inspect Nostr tags (e.g. CEP-8 `cap` tags) that are not present in the JSON-RPC payload.

## 0.4.0

### Minor Changes

- feat(payments): implement CEP-8 invoice-based payment flow
  - Add server-side payment gating middleware (createServerPaymentsMiddleware)
  - Add client-side payment handler wrapper (withClientPayments)
  - Implement PMI discovery and selection (client preference wins)
  - Add correlated notifications (payment_required, payment_accepted)
  - Support dynamic pricing via resolvePrice callback
  - Add CEP-8 cap tags for capability pricing advertisement
  - Add CEP-8 pmi tags for payment method identification
  - Implement idempotency by request event id
  - Add TTL-based verification timeout handling
  - Implement fail-closed error handling for payment operations
  - Add fake payment processor/handler for testing
  - Add comprehensive tests for payment flow, PMI selection, idempotency,
    client edge cases, and error handling
  - Remove unused createPmiTagsFromHandlers helper

### Patch Changes

- 9432fad: fix(gateway): detach event handlers before closing transport

## 0.3.2

### Patch Changes

- fix(gateway): recreate transport on client re-initialization

  When an initialize request is received, close any existing transport
  for the client to prevent "already initialized" errors with stateful
  transports (e.g., Streamable HTTP). Adds closeClientTransport helper
  for proper cleanup.

## 0.3.1

### Patch Changes

- refactor(gateway): make mcpClientTransport optional

  Made mcpClientTransport optional in NostrMCPGatewayOptions and added
  validation to ensure either mcpClientTransport or
  createMcpClientTransport is provided. Updated methods to handle the
  optional transport, improving flexibility for both single-client and
  per-client modes.

  BREAKING CHANGE: mcpClientTransport is now optional; provide either
  mcpClientTransport or createMcpClientTransport.

## 0.3.0

### Minor Changes

- feat(gateway): add per-client MCP routing support

  This commit introduces per-client MCP routing in the NostrMCPGateway. When a
  `createMcpClientTransport` factory is provided, the gateway will isolate MCP
  sessions per Nostr client pubkey. It uses an LRU cache to manage per-client
  transports and evicts them when the Nostr session is evicted.

  The NostrServerTransport is extended with:
  - A `maxSessions` option to control the number of client sessions.
  - An `onClientSessionEvicted` callback for cleanup.
  - A `onmessageWithContext` event to route messages with client context.

  A new test file verifies the per-client routing and eviction behavior.

## 0.2.10

### Patch Changes

- fix: ensure ApplesauceRelayPool.disconnect() exits cleanly
  - Await relay close$ with bounded timeout
  - Disable reconnect timers during shutdown to prevent Node event-loop keep-alive
  - Add regression tests for both behaviors

## 0.2.9

### Patch Changes

- fix(relay): ensure relay close handshake completes on disconnect

The disconnection process now waits for the relay close handshake (with a bounded timeout) to ensure clean shutdown and prevent memory leaks. The `safelyCloseRelay` method is now async and can optionally wait for the close handshake. The `disconnect` method also waits for any in-flight rebuild (with a timeout) before proceeding.

Additionally, tests have been updated to reflect the new async behavior and a new test verifies that disconnect waits for the close$ emission.

## 0.2.8

### Patch Changes

- chore: enhance SDK packaging and CI/CD validation
  - Add export verification script (scripts/verify-exports.ts) with:
    - File extension validation (.js/.d.ts)
    - Types field consistency check
    - Files coverage validation
  - Remove broken @arethetypeswrong/cli from CI
  - Update README with package structure docs (root vs subpath imports)
  - Simplify verify-exports.ts helpers with Array.some()
  - Export announcement-manager.js for ServerInfo type visibility
  - Add "./transport" export entry to package.json
  - Add conditional exports with types/default for proper TS support
  - Set sideEffects: false for tree-shaking

## 0.2.7

### Patch Changes

- refactor(nostr-server): optimize correlation store and client index

## 0.2.6

### Patch Changes

- refactor: update BaseNostrTransport to support string[] relayHandler option
  - Add comprehensive AGENTS.md with TypeScript and project guidelines
  - Replace RULES.md with new AGENTS.md documentation
  - Add CLAUDE.md reference file
  - Enhance tsconfig.json with stricter TypeScript compilation options

  BREAKING CHANGE: relayHandler option now accepts string[] in addition to RelayHandler

## 0.2.5

### Patch Changes

- 504ea75: fix(task-queue): make shutdown async and wait for running tasks

  The shutdown method now waits for running tasks to complete with a
  configurable timeout instead of immediately clearing them. This provides
  more graceful shutdown behavior and prevents dropping in-progress tasks.

- fix(nostr-server): prevent session eviction with active routes

  Add shouldEvictSession hook to SessionStore to check for active routes
  before evicting sessions. This prevents sessions from being removed
  while they have in-flight requests, which could cause data loss or
  errors. The CorrelationStore now provides hasActiveRoutesForClient
  to track active routes per client. Includes comprehensive tests for
  the new eviction protection logic.

  Updated dependencies:
  - @modelcontextprotocol/sdk to 1.25.3
  - pino to 10.2.1
  - typescript-eslint to 8.53.1

## 0.2.4

### Patch Changes

- fix(relay): improve relay cleanup error handling and test coverage

## 0.2.3

### Patch Changes

- fix(relay): prevent memory leaks in relay pool cleanup

  Implement defensive cleanup to prevent memory leaks from incomplete RxJS
  subject completion in applesauce-relay library. Add safelyCloseRelay() and
  completeSubjectSafely() methods to properly close all relay subjects.
  - Increase ping frequency from 30s to 2min to reduce rebuild cycles
  - Configure keepAlive to prevent premature socket teardown
  - Add jitter to ping monitor to avoid thundering herd
  - Skip liveness checks when no active subscriptions exist
  - Add comprehensive tests for cleanup logic
  - Update .gitignore for development artifacts

  Addresses production memory leak analysis where Relay.close() only calls
  socket.unsubscribe() without completing internal BehaviorSubjects.

## 0.2.2

### Patch Changes

- fix: self referencing

## 0.2.1

### Patch Changes

- refactor(transport): fix import paths to use relative imports

## 0.2.0

### Minor Changes

- 0.2.0 release notes

  This release focuses on **modularity**, **robustness**, and **consistency** improvements across the transport and relay layers, drawing inspiration from production-grade patterns.

  ### Major Refactors
  - **refactor(transport): split NostrServerTransport into modular components**
    - Broken down into `announcement-manager`, `authorization-policy`, `correlation-store`, and `session-store`.
    - Improves maintainability and separation of concerns.
    - Adopts thin-facade patterns similar to the MCP TypeScript SDK.
  - **refactor(nostr-client-transport): add correlation store and stateless mode**
    - Added `ClientCorrelationStore` for request/response correlation with LRU cache.
    - Introduced `StatelessModeHandler` for stateless mode emulation.
    - Refactored `NostrClientTransport` to use new modules for better clarity.

  ### New Features & Improvements
  - **feat(relay): add liveness checks and auto-rebuild**
    - Implemented liveness monitoring in `ApplesauceRelayPool` to detect unresponsive relays.
    - Uses periodic pings with a dummy filter and triggers automatic rebuild on timeout.
    - Subscriptions are preserved and replayed after rebuild to maintain continuity.
    - Added configuration options for ping frequency and timeout.
  - **fix(relay): improve liveness check robustness**
    - Enhanced liveness check to handle edge cases (no relays or no connected relays).
    - Refactored ping mechanism to use RxJS observables for improved reliability.
  - **feat(transport): add timeout handling and graceful shutdown**
    - Added timeout wrapper utility to prevent hanging network operations.
    - Implemented graceful shutdown for task queue to prevent stale operations.
    - Fixed memory leaks in relay pool and announcement manager.
    - Improved error handling in LRU cache eviction callbacks.

  ### Bug Fixes
  - **fix(transport): optimize error handling and correlation store**
    - Changed `logAndRethrowError` to `protected` in base transport for inheritance.
    - Added `clientEventIds` map in `CorrelationStore` to track event IDs per client, enabling O(1) lookups.

  ### Maintenance
  - **build(deps): update dependencies**
    - Updated several dependencies to their latest versions.
    - Removed `pino-pretty` dependency as logging now outputs directly to stderr.

### Patch Changes

- 9a7128f: Fix package importing missing `@noble/hashes` dependency

## 0.1.48

### Patch Changes

- feat(deps): implement automated dependency checking

## 0.1.47

### Patch Changes

- build(deps): downgrade nostr-tools

## 0.1.46

### Patch Changes

- feat(relay): enhance publish method with indefinite retries and controlled logging

## 0.1.45

### Patch Changes

- feat(relay): enhance publish method with indefinite retries and controlled logging

## 0.1.44

### Patch Changes

- fix: reconnectTimer

## 0.1.43

### Patch Changes

- feat(relay): enhance publish method with indefinite retries and controlled logging

## 0.1.42

### Patch Changes

- feat: update dependencies and enhance relay pool functionality
  - Update @modelcontextprotocol/sdk from 1.24.2 to 1.25.1
  - Update devDependencies: @eslint/js, @types/bun, eslint, typescript-eslint
  - Update dependencies: nostr-tools
  - Switch mock transport to use ApplesauceRelayPool
  - Add getRelayUrls method to RelayHandler interface
  - Improve relay reconnection with retries and resubscribe options
  - Update base transport logging to include relay URLs
  - Adapt server transport to new MCP SDK response types

## 0.1.41

### Patch Changes

- feat(transport): add optional client public key injection to MCP requests

## 0.1.40

### Patch Changes

- feat: implement robust relay reconnection for transports
  - Fix relay restart issue in ApplesauceRelayPool by increasing publishTimeout and leveraging Applesauce's built-in reconnection
  - Add comprehensive reconnection tests covering basic restarts, multiple restarts, and extended outages
  - Simplify logging and reduce verbosity while maintaining essential debugging
  - Ensure server transport can publish messages seamlessly after relay restarts

## 0.1.39

### Patch Changes

- refactor(async): improve reconnection handling, async architecture improvements
  - Add observability for relay connection state monitoring in ApplesauceRelayPool
  - Add test for server restart and continued request processing in NostrClientTransport
  - Update dependencies in package.json and bun.lock
  - Add TaskQueue utility for non-blocking event processing with configurable concurrency
  - Parallelize transport startup operations using Promise.all for reduced latency
  - Implement LRU cache for session and request management with fixed capacity
  - Optimize authorization lookup from O(N) to O(1) using Set
  - Update notification broadcasting to use TaskQueue for backpressure handling
  - Create reusable LruCache utility eliminating code duplication

## 0.1.38

### Patch Changes

- fix(logger): resolve browser build compatibility with Pino.js
  - Refactor logger to use Pino's built-in browser configuration
  - Add environment detection to isolate Node.js-specific code
  - Maintain file logging support in Node.js while enabling browser builds
  - Ensure consistent API across both environments without breaking changes

## 0.1.37

### Patch Changes

- fix(logger): detect enviroment

## 0.1.36

### Patch Changes

- fix(logger): lintin error, and handle pino pretty gracefully

## 0.1.35

### Patch Changes

- fix(logger): add fallback for missing pino-pretty
  - Gracefully handle missing pino-pretty dependency by implementing try-catch fallback to basic JSON logging

## 0.1.34

### Patch Changes

- refactor(logger): Improve logger configuration and instance-based logging
  - Refactor logger configuration to use singleton pattern for better performance
  - Add 'silent' log level option for complete log suppression
  - Change transport classes to use instance-specific loggers with configurable levels
  - Remove redundant environment variable handling functions
  - Simplify logger creation process and improve configuration management
  - Update all transport classes to pass module names and log levels to logger instances

## 0.1.33

### Patch Changes

- fix: pino logger in browser enviroments

## 0.1.32

### Patch Changes

- fix: pino logger in browser enviroments

## 0.1.31

### Patch Changes

- chore: bump version

## 0.1.30

### Patch Changes

- 2f8d260: fix(relay): update applesauce-relay to v4 and adapt API usage
  - Update applesauce-relay dependency from v3.1.0 to v4.0.0
  - Adapt RelayPool constructor to use new Relay API with publishTimeout
  - Add detailed logging for better debugging of relay operations
  - Add test case for handling offline relays in the pool

## 0.1.30-rc.2

### Patch Changes

- fix(transport): improve session management and error handling

## 0.1.30-rc.1

### Patch Changes

- Fix crash handling and improve error logging in Nostr transports:
  - Fix Pino buffered writes to prevent log loss during crashes
  - Add comprehensive error handlers to all async operations
  - Wrap major async flows in try-catch blocks with detailed logging
  - Add periodic cleanup of inactive client sessions to prevent memory leaks
  - Enhance error context logging with stack traces and relevant identifiers
  - Apply consistent error handling patterns across all transport layers

## 0.1.30-rc.0

### Patch Changes

- Release candidate for testing - next

## 0.1.29

### Patch Changes

- 08be76f: feat(transport): add stateless mode support for nostr client transport
- fc91d44: chore: bump versions
- 34058d4: fix(auth): handle unauthorized requests in public server

## 0.1.28

### Patch Changes

- refactor(nostr-server-transport): check if excluded capabilities have length to proceed with the validation
- f127712: chore: log new sessions just when they are created

## 0.1.27

### Patch Changes

- fix(nostr-server-transport): unauthorized errors due to not validating notifications

## 0.1.26

### Patch Changes

- feat(transport): add capability exclusion for whitelisting

  Add support for excluding specific capabilities from public key whitelisting
  requirements, allowing certain operations from disallowed public keys. This
  enhances security policy flexibility while maintaining backward compatibility.

  The implementation includes:
  - CapabilityExclusion interface and excludedCapabilities option
  - isCapabilityExcluded method for exclusion checks
  - Updated authorization logic
  - New test to verify exclusion behavior

## 0.1.25

### Patch Changes

- chore: bump applesauce-relay to latest

## 0.1.24

### Patch Changes

- fix(transport): enhance event validation and disconnect handling

## 0.1.23

### Patch Changes

- feat(transport): add announcement deletion capability and improve event filtering

## 0.1.22

### Patch Changes

- refactor(transport): improve initialization timeout handling

## 0.1.21

### Patch Changes

- refactor(transport): improve initialization process

## 0.1.20

### Patch Changes

- refactor(server-transport): improve logging with logger.info

## 0.1.19

### Patch Changes

- refactor(transport): replace bun import with internal utils

## 0.1.18

### Patch Changes

- refactor: add complete initialization lifecycle for announcements, rename mcpServerTransport to mcpClientTransport in gateway

## 0.1.17

### Patch Changes

- feat(relay): remove nostrify library integration and added ApplesauceRelayPool implementation

## 0.1.16

### Patch Changes

- feat(relay): add nostrify library integration and NostrifyRelayPool implementation

## 0.1.15

### Patch Changes

- chore: bump packages versions
- feat(private-key-signer) Allow undefined to generate new secret key

## 0.1.14

### Patch Changes

- feat(nostr): add about tag support and store initialization event in client transport, refactor tag generation

## 0.1.13

### Patch Changes

- fix: logger in browser env

## 0.1.12

### Patch Changes

- ee82a52: feat: improve relay reconnection handling with subscription persistence
- eecd6af: fix: handle malformed json content in nostr events gracefully
- dd8f444: feat: implement structured logging system with configurable levels
- c18f47c: refactor: nostr signer with nip44 encryption and remove direct secret key access
- 636b197: chore: bump deps
- d5fd1a8: feat: add message validation and relay reconnection with exponential backoff

## 0.1.11

### Patch Changes

- fix: server transport message format mirroring
