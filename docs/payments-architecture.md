---
title: Payments High-Level Architecture
description: High-level design for integrating CEP-8 payments into the ContextVM TypeScript SDK
---

# Payments High-Level Architecture

This document summarizes the high-level SDK design for integrating payments as specified in [CEP-8](/spec/ceps/cep-8). It complements the more detailed implementation plan in [`payments.md`](src/content/docs/ts-sdk/payments.md:1).

## Goals

- Keep payments **optional** and **modular**.
- Support **multiple payment methods** simultaneously.
- Preserve separation of responsibilities:
  - **Server transport** acts as the payment *processor* (issues requests, verifies settlement).
  - **Client transport** acts as the payment *handler* (executes payment with a wallet).
- Avoid baking rail-specific details (Lightning, Cashu, on-chain, etc.) into core transports.

## Integration decision: middleware-first (locked)

Payments are integrated as **middleware around message flow**, not as core transport features.

- Transports remain responsible for Nostr <-> JSON-RPC conversion, correlation, encryption, and routing.
- The payments layer is responsible for:
  - Detecting priced capability invocations.
  - Emitting CEP-8 payment notifications.
  - Gating forwarding to the underlying MCP server until payment is verified.

This keeps payments optional, modular, and testable without coupling rail logic into transports.

## Core concept: PMI-keyed modules

Payments are integrated via two plugin types, each keyed by a Payment Method Identifier (PMI).

- **Client-side:** `PaymentHandler` modules
- **Server-side:** `PaymentProcessor` modules

Each module supports exactly one `pmi` string (example: `bitcoin-lightning-bolt11`).

### Client transport configuration

The client stack is configured with an ordered list of handlers:

```ts
const paymentHandlers: PaymentHandler[] = [
  new LnBolt11PaymentHandler(/* ... */),
  new CashuPaymentHandler(/* ... */),
];

const transport = new NostrClientTransport({
  /* existing options */
});

const paidTransport = withClientPayments(transport, {
  handlers: paymentHandlers,
});
```

Handler order expresses **client preference**. This ordering is also used when advertising supported PMIs via `pmi` tags (first = highest priority).

### Server transport configuration

The server stack is configured with an ordered list of processors:

```ts
const paymentProcessors: PaymentProcessor[] = [
  new LnBolt11PaymentProcessor(/* ... */),
  new CashuPaymentProcessor(/* ... */),
];

const transport = new NostrServerTransport({
  /* existing options */
});

const pricedCapabilities = [
  {
    method: 'tools/call',
    name: 'get_weather',
    amount: 100,
    currencyUnit: 'sats',
  },
];

const paidTransport = withServerPayments(transport, {
  processors: paymentProcessors,
  pricedCapabilities,
});
```

Processor order expresses **server preference** when multiple PMIs are viable.

## Message flow (paid capability request)

This section describes the expected behavior at a high level. Exact field names and correlation requirements are defined in [CEP-8](/spec/ceps/cep-8).

### 1) Client sends capability request (with optional PMI tags)

- Client sends a normal MCP request over ContextVM.
- For paid capabilities—especially in stateless mode—the SDK SHOULD attach one or more `pmi` tags indicating supported methods.

### 2) Server responds with `notifications/payment_required`

- Server detects a priced capability.
- Server selects a PMI.
  - If the client advertised PMIs, select from the intersection.
  - If the client did not advertise PMIs, the server MAY emit multiple payment requests (one per supported processor), but the default behavior SHOULD be to emit one when possible.
- Server emits `notifications/payment_required` correlated to the original request.

### 3) Client selects a handler and pays

- Client receives `notifications/payment_required`.
- Client looks up a handler by `pmi`.
- If no handler exists (unsupported PMI), the client ignores the request.
- If handler exists, it pays using the opaque `pay_req` string.

### 4) Server verifies and acknowledges with `notifications/payment_accepted`

- Server-side processor verifies settlement.
- Server emits `notifications/payment_accepted`, correlated to the same request.
- This notification is a signed receipt signal.

### 5) Server fulfills the original request

- After payment acceptance, the server forwards the original MCP request to the underlying MCP server implementation.
- The normal JSON-RPC response is returned to the client.

## Security + performance guardrails (locked)

The SDK MUST fail closed for priced requests:

1. **No unpaid forwarding:** a priced request MUST NOT be forwarded to the underlying MCP server until payment is verified.
2. **Gate at the forwarding seam:** the payment gate MUST wrap the code path that calls the underlying server transport (so the underlying server cannot respond to unpaid requests).
3. **Bounded pending-payment state:** track pending payments with bounded memory (LRU) and TTL to mitigate spam/DoS.
4. **Idempotency by request event id:** retries of the same request event id MUST NOT result in multiple charges.

## PMI selection strategy (deterministic + minimal)

Recommended SDK behavior:

1. Parse client-advertised PMIs from request tags (if present).
2. Determine `eligible = intersection(clientPMIs, serverProcessorsPMIs)`.
3. If `eligible` is non-empty: choose the first PMI according to **client order** (client preference).
4. Otherwise: choose the first PMI according to **server order** (server preference), or emit multiple payment_required notifications if configured.

This keeps behavior predictable while allowing server flexibility.

## Where this integrates in the SDK

At a high level, payments should be implemented as a middleware layer around transport message flow:

- Client: intercept correlated payment notifications before they reach application code.
- Server: intercept inbound requests before they reach the underlying MCP server.

Transport specifics that matter for payment integration:

- The server transport rewrites inbound request ids to the request Nostr event id in [`NostrServerTransport.handleIncomingRequest()`](../../../ts-sdk/src/transport/nostr-server-transport.ts:282).
- The client transport must correctly support correlated notifications (notifications that include an `e` tag) in [`NostrClientTransport.processIncomingEvent()`](../../../ts-sdk/src/transport/nostr-client-transport.ts:223).

## Example: PMI advertisement from handler array

The handler array can be used to derive outbound `pmi` tags:

```ts
const pmiTags = paymentHandlers.map((h) => ["pmi", h.pmi]);
// appended to the request event tags
```

This keeps PMI support declaration consistent with actual client capabilities.
