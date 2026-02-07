---
title: Payments (CEP-8) Implementation Review
description: Code review of the current CEP-8 payments integration (compliance, risks, and recommended changes)
---

# Payments (CEP-8) Implementation Review

This document captures a focused review of the current SDK payments implementation with respect to CEP-8. It summarizes what is already correct, highlights remaining gaps/risk areas (race conditions, idempotency, lifecycle), and proposes concrete (non-breaking where possible) improvements with code-oriented snippets.

## Scope

- Server-side CEP-8 discovery: `cap` and `pmi` tag advertisement
- Server-side gating of priced capabilities (`notifications/payment_required` + `notifications/payment_accepted` + fail-closed forwarding)
- Client-side correlated-notification routing and payment handling
- Operational hardening: idempotency, retry behavior, memory bounds, timeouts

Primary touchpoints:

- Server gating middleware: [`createServerPaymentsMiddleware()`](../src/payments/server-payments.ts:113)
- Server attachment + discovery tags: [`withServerPayments()`](../src/payments/server-transport-payments.ts:20)
- `cap` tags generator: [`createCapTagsFromPricedCapabilities()`](../src/payments/cap-tags.ts:13)
- `pmi` tags generator: [`createPmiTagsFromProcessors()`](../src/payments/pmi-tags.ts:24)
- Announcement/list tagging: [`AnnouncementManager.getAnnouncementMapping()`](../src/transport/nostr-server/announcement-manager.ts:194)
- Client correlated notification routing: [`NostrClientTransport.processIncomingEvent()`](../src/transport/nostr-client-transport.ts:239)
- CEP-8 spec reference: [`docs/cep-8.md`](cep-8.md:1)

Related design docs:

- High-level architecture: [`docs/payments-architecture.md`](payments-architecture.md:1)
- SDK payments plan/notes: [`docs/payments.md`](payments.md:1)

## Executive summary

What’s solid:

1) **Discovery compliance is in good shape**: the server advertises `cap` and `pmi` tags in the intended surfaces (announcement and list events).
2) **Client message classification is now correct** for CEP-8 correlated notifications (notifications that include an `e` tag).
3) **Fail-closed gating is implemented at the forwarding seam** via server inbound middleware.
4) **Pending-payment tracking is bounded** (LRU) and has TTL-based cleanup.

Main gaps / risks (highest priority):

1) ✅ **Idempotency is atomic**: duplicates for the same request event id are deduped via an in-flight state.
2) ✅ **Duplicate retry behavior is retry-friendly**: duplicates await the in-flight result (no resend cadence).
3) ✅ **Verification is timeout-bounded**: `verifyPayment()` is bounded by CEP-8 `ttl` (default 5 minutes).
4) ✅ **Client handlers receive correlation context**: request event id is passed through to handlers when transport provides context.

Status update (2026-02):

- ✅ Resolved: atomic, retry-friendly server-side idempotency with in-flight dedupe (no resend cadence).
- ✅ Resolved: `verifyPayment()` is TTL-bounded (default 5 minutes when TTL is absent).
- ✅ Resolved: client correlation context is passed via `onmessageWithContext` and forwarded to handlers.
- ✅ Improved: client-side dedupe by `pay_req` prevents double-pay on duplicate `payment_required` delivery.

## CEP-8 compliance checklist (current)

### A) `cap` tags (pricing discovery)

CEP-8 defines `cap` tags as a reference price surface (not the definitive charged amount). See [`docs/cep-8.md`](cep-8.md:46).

Current behavior:

- Pricing config (`PricedCapability[]`) is converted to `cap` tags via [`createCapTagsFromPricedCapabilities()`](../src/payments/cap-tags.ts:13).
- These tags are injected into:
  - server announcement events and
  - list-kind announcement events
  via [`withServerPayments()`](../src/payments/server-transport-payments.ts:20) and [`AnnouncementManager.getAnnouncementMapping()`](../src/transport/nostr-server/announcement-manager.ts:194).

Notes:

- The implementation currently advertises **fixed prices** only (stringified numbers). CEP-8 also allows ranges; support could be added later without breaking the current API, but would require extending [`PricedCapability`](../src/payments/types.ts:20).
- The implementation supports **fixed prices** and CEP-8 **price ranges** via optional `maxAmount` on [`PricedCapability`](../src/payments/types.ts:20).

### B) `pmi` tags (PMI discovery)

CEP-8 defines PMI advertisement via repeated `['pmi', '<pmi>']` tags. See [`docs/cep-8.md`](cep-8.md:71).

Current behavior:

- Server advertises PMIs derived from processor order via [`createPmiTagsFromProcessors()`](../src/payments/pmi-tags.ts:24) attached in [`withServerPayments()`](../src/payments/server-transport-payments.ts:20).
- Client can advertise PMIs on requests via the outbound tag hook: [`createClientPmiOutboundTagHook()`](../src/payments/pmi-tags.ts:35).

### C) Payment notifications + correlation

CEP-8 requires:

- `notifications/payment_required` includes `amount`, `pay_req`, `pmi`, optional `description`, optional `ttl`, optional `_meta`.
- `notifications/payment_accepted` includes `amount`, `pmi`, optional `receipt`, optional `_meta`.
- Both MUST include an `e` tag pointing at the request event id. See correlation requirements in [`docs/cep-8.md`](cep-8.md:360).

Current behavior:

- Server sends correlated notifications via [`NostrServerTransport.sendNotification()`](../src/transport/nostr-server-transport.ts:510) which adds the `e` tag when `correlatedEventId` is provided.
- Payments middleware uses that interface via [`CorrelatedNotificationSender`](../src/payments/types.ts:136) and passes `requestEventId` as the correlation id in [`createServerPaymentsMiddleware()`](../src/payments/server-payments.ts:113).

Client routing:

- Client now routes notifications by JSON-RPC type in [`NostrClientTransport.processIncomingEvent()`](../src/transport/nostr-client-transport.ts:239), which is necessary because CEP-8 notifications are correlated.

## Current implementation overview

### Server-side

Attachment:

- [`withServerPayments()`](../src/payments/server-transport-payments.ts:20) does two things:
  1) sets server announcement extra tags for PMI discovery
  2) sets pricing tags for `cap` advertisement
  3) attaches the inbound gating middleware

Gating:

- [`createServerPaymentsMiddleware()`](../src/payments/server-payments.ts:113) checks inbound requests, matches a priced capability, selects a processor (PMI), emits `payment_required`, verifies payment, emits `payment_accepted`, then forwards the request.

Idempotency guard:

- Uses bounded pending-payment state with [`LruCache<T>`](../src/core/utils/lru-cache.ts:4) keyed by `requestEventId`.

### Client-side

- [`withClientPayments()`](../src/payments/client-payments.ts:24) wraps a transport; when it observes `notifications/payment_required` it finds a handler by PMI and calls `handler.handle()` asynchronously.

## Risks and gaps (detailed)

### 1) Non-atomic idempotency (double-charge race)

Problem:

- The current “pending check then set” in [`createServerPaymentsMiddleware()`](../src/payments/server-payments.ts:113) is not atomic.
- Under concurrent duplicate delivery of the same `requestEventId`, two executions can pass the `pending.get()` check before either stores state.

Why this matters:

- CEP-8 states servers MUST NOT charge more than once for duplicate request event ids. See idempotency in [`docs/cep-8.md`](cep-8.md:360).

Recommendation:

- Store a single “in-flight promise/state” per `requestEventId` (set immediately) so duplicates await or short-circuit deterministically.

### 2) Duplicate retries can be black-holed

Problem:

- If a duplicate arrives while an entry is pending and not expired, the middleware returns early and does nothing (no forward and no re-send).

Why this matters:

- Clients retrying the same event id for reliability can observe timeouts that look like server flakiness.

Recommendation:

- Track a minimal per-request state machine and re-send the same `payment_required` on duplicate (rate-limited), or at least respond with a deterministic signal.

### 3) Hanging `verifyPayment()` can pin state until TTL

Problem:

- If `verifyPayment()` never resolves, the `finally` block in [`createServerPaymentsMiddleware()`](../src/payments/server-payments.ts:113) will not run.
- The entry remains until TTL expiry and opportunistic purge.

Recommendation:

- Add an upper bound timeout around payment verification (and optionally invoice creation).
- Consider treating timed-out verification as “not accepted” and clearing state.

### 4) Client handler lacks correlation context

Problem:

- [`withClientPayments()`](../src/payments/client-payments.ts:24) passes `requestEventId: 'unknown'`.

Why this matters:

- Wallet UX, audit logs, and policy gating often need a stable correlation id.

Recommendation:

- Extend the client transport/middleware surface so the payments layer can access the correlated `e` tag / request event id.
- If you want to avoid an API change, an interim approach is dedupe and policy keyed on `pay_req`.

### 5) Client-side unbounded concurrency (optional hardening)

Problem:

- Payment handling is fire-and-forget and can run concurrently for multiple `payment_required` notifications.

Recommendation:

- Add optional dedupe/concurrency limiting keyed by `pay_req`.

## Recommended changes (code-oriented, non-breaking intent)

The following snippets are illustrative “patch-shaped” proposals. They are retained as historical context; the changes have since been implemented.

### Change 1: Atomic, retry-friendly server idempotency state

Goal:

- Ensure duplicates do not double-charge.
- Ensure duplicates don’t black-hole: either await the in-flight result or re-send `payment_required`.

Suggested shape inside [`createServerPaymentsMiddleware()`](../src/payments/server-payments.ts:113):

```ts
type PendingPaymentState = {
  expiresAtMs: number;
  status: 'processing' | 'required-sent' | 'accepted' | 'forwarded';
  payReq?: {
    amount: number;
    pay_req: string;
    pmi: string;
    description?: string;
    ttl?: number; // seconds (CEP-8)
    _meta?: Record<string, unknown>;
  };
  inFlight?: Promise<void>;
  lastRequiredSentAtMs?: number;
};

// Pseudocode strategy:
// - pending.set(id, { status:'processing', inFlight: promise }) must happen synchronously.
// - duplicates:
//   - if inFlight exists, await it OR re-send payment_required if payReq is available
//     (rate-limited) then return.
// - once accepted, duplicates can forward immediately.
```

Key behavior decision:

- Prefer “duplicates await in-flight” to reduce extra protocol spam.
- Prefer “duplicates await in-flight” to reduce extra protocol spam.
- Note: re-sending `payment_required` at a cadence is intentionally not implemented.

### Change 2: Add verification timeout

Goal:

- Prevent indefinite pinning of pending state.

Suggested helper usage near `verifyPayment` in [`createServerPaymentsMiddleware()`](../src/payments/server-payments.ts:113):

```ts
const verified = await withTimeout(
  processor.verifyPayment({ pay_req, requestEventId, clientPubkey }),
  ttlMs,
  'verifyPayment timed out',
);
```

If you want to avoid coupling payments to transport utils, keep a tiny local `withTimeout` helper inside the payments module.

### Change 3: Clarify `ttl` units in types

Goal:

- Prevent future PMI processors from returning TTL in ms.

Suggested doc change in [`PaymentProcessor.createPaymentRequired()` return type](../src/payments/types.ts:101):

```ts
ttl?: number; // seconds, per CEP-8
```

### Change 4: Client correlation context (design direction)

Goal:

- Provide the payment handler a real request event id.

Two non-breaking-ish directions:

1) Add a parallel callback path for client notifications that preserves correlation id (e.g. internal `onmessageWithContext` on the client transport similar to server).
2) Alternatively, enrich the notification object that reaches middleware with correlation id.

Current constraint:

- [`withClientPayments()`](../src/payments/client-payments.ts:24) only sees `JSONRPCMessage`, not the underlying Nostr event tags.

## Follow-up work (tests to add before changing behavior)

Add tests that lock in desired behavior changes:

- Duplicate in-flight delivery should not double-charge and should not hang.
- Verify timeout clears pending state.
- Client dedupe prevents concurrent double-handle by `pay_req`.

Existing useful tests to extend:

- End-to-end flow: [`src/transport/payments-flow.test.ts`](../src/transport/payments-flow.test.ts:1)
- Server discovery tags: [`src/transport/nostr-server-transport.test.ts`](../src/transport/nostr-server-transport.test.ts:138)

## Appendix: Notes on current code quality

- The separation between discovery/tag generation ([`src/payments/cap-tags.ts`](../src/payments/cap-tags.ts:1), [`src/payments/pmi-tags.ts`](../src/payments/pmi-tags.ts:1)) and transport wiring ([`src/payments/server-transport-payments.ts`](../src/payments/server-transport-payments.ts:1)) is a maintainability win.
- The server inbound middleware chain in [`NostrServerTransport.authorizeAndProcessEvent()`](../src/transport/nostr-server-transport.ts:613) is a general-purpose extensibility mechanism; payments benefits from it without deep coupling.
- The client-side payment wrapper is deliberately best-effort; hardening (dedupe/concurrency limits) should be opt-in so it doesn’t change baseline transport semantics unexpectedly.
