---
title: Payments Design (CEP-8)
description: Design notes and implementation plan for adding CEP-8 payment handling to the ContextVM TypeScript SDK
---

# Payments Design (CEP-8)

This document describes a modular design and implementation plan for adding payment handling to the `@contextvm/sdk`, aligned with [CEP-8](/spec/ceps/cep-8) (capability pricing, PMI discovery, and payment notifications).

The goal is to keep payments **optional** and **pluggable**, avoid coupling payment-rail details into the transport core, and ensure the SDK correctly handles **correlated notifications** (notifications that include an `e` tag).

## Key insights from the current SDK

### 1) Client transport currently mis-routes correlated notifications

The SDK client transport routes _any_ event with an `e` tag as a response, and only events without `e` as notifications. See the routing decision in [`NostrClientTransport.processIncomingEvent()`](../../../ts-sdk/src/transport/nostr-client-transport.ts:223).

CEP-8 payment notifications are **notifications** and MUST include an `e` tag to correlate them to the original request.

**Implication:** before implementing payment handlers, the SDK must support correlated notifications as first-class messages.

### 2) Server transport already uses request event ids as the stable correlation handle

On the server side, inbound JSON-RPC request ids are rewritten to the Nostr event id to avoid collisions, in [`NostrServerTransport.handleIncomingRequest()`](../../../ts-sdk/src/transport/nostr-server-transport.ts:282).

That makes CEP-8 correlation straightforward: the `e` tag in `notifications/payment_required` and `notifications/payment_accepted` references the request event id.

### 3) The SDK needs a generic “extra tags per outbound event” mechanism

CEP-8 stateless guidance expects clients to include one or more `pmi` tags on requests.

Today the client constructs tags internally in [`NostrClientTransport.sendRequest()`](../../../ts-sdk/src/transport/nostr-client-transport.ts:177) using `createRecipientTags()` (not externally configurable per message).

**Implication:** implement a small extensibility surface so higher layers can attach protocol tags like `pmi` without forking transports.

## Design: modular payment components

The design introduces optional registries on both client and server sides:

- **PaymentHandler** (client-side): can interpret and execute a payment request for one PMI.
- **PaymentProcessor** (server-side): can generate a payment request (`pay_req`) and verify settlement for one PMI.

### PaymentHandler interface (client)

```ts
export interface PaymentHandler {
  /** The PMI this handler supports (e.g. "bitcoin-lightning-bolt11") */
  readonly pmi: string;

  /**
   * Optional pre-flight check. Allows the handler to decline for policy reasons.
   * Example: user disabled this payment method, max amount exceeded, etc.
   */
  canHandle?(req: {
    amount: number;
    pay_req: string;
    description?: string;
    requestEventId: string;
  }): boolean | Promise<boolean>;

  /** Execute the payment (wallet action). */
  handle(req: {
    amount: number;
    pay_req: string;
    description?: string;
    requestEventId: string;
  }): Promise<void>;
}
```

### PaymentProcessor interface (server)

```ts
export interface PaymentProcessor {
  /** The PMI this processor can issue/verify */
  readonly pmi: string;

  /** Create a payment request for a specific capability invocation */
  createPaymentRequired(params: {
    amount: number;
    description?: string;
    requestEventId: string;
    clientPubkey: string;
  }): Promise<{
    amount: number;
    pay_req: string;
    description?: string;
    pmi: string;
  }>;

  /** Wait for and/or verify settlement for a previously issued pay_req */
  verifyPayment(params: {
    pay_req: string;
    requestEventId: string;
    clientPubkey: string;
  }): Promise<{ receipt?: string }>;
}
```

Notes:

- Both sides treat `pay_req` as **opaque**.
- The SDK’s payment layer does not standardize proof formats; each PMI module owns its encoding.

## Transport integration (minimal, but correct)

### A) Correctly route correlated notifications on the client

Client-side message classification should be based on the JSON-RPC message type, not on the presence of an `e` tag.

Conceptually:

```ts
const correlatedEventId = getNostrEventTag(tags, "e");
const mcpMessage = convertNostrEventToMcpMessage(event);

if (isJSONRPCResponse(mcpMessage)) {
  handleResponse(correlatedEventId, mcpMessage);
} else if (isJSONRPCNotification(mcpMessage)) {
  handleNotification(mcpMessage, correlatedEventId);
}
```

This change is centered around [`NostrClientTransport.processIncomingEvent()`](../../../ts-sdk/src/transport/nostr-client-transport.ts:223) and [`NostrClientTransport.handleNotification()`](../../../ts-sdk/src/transport/nostr-client-transport.ts:368).

### B) Add an outbound tag injection hook (client)

Add a small option/callback to inject extra tags based on the outgoing JSON-RPC message.

Conceptually:

```ts
type OutboundTagHook = (msg: JSONRPCMessage) => string[][];

// In sendRequest():
const tags = [
  ...createRecipientTags(serverPubkey),
  ...(outboundTagHook?.(message) ?? []),
];
```

This enables:

- Including `pmi` tags on paid requests (especially stateless).
- Future CEPs that introduce new tags without reworking transport internals.

### C) Add a payment middleware layer (client + server)

Payments should be handled as an optional middleware around `Transport.onmessage` and/or `onmessageWithContext`.

#### Client middleware responsibilities

- Listen for `notifications/payment_required` correlated to a request.
- Select the correct `PaymentHandler` based on `pmi`.
- Execute the handler.
- Optionally wait for `notifications/payment_accepted` as a signed receipt.

#### Server middleware responsibilities

- Detect that a request targets a priced capability.
- Choose a PMI (prefer intersection with client-provided `pmi` tags when present).
- Emit `notifications/payment_required` via [`NostrServerTransport.sendNotification()`](../../../ts-sdk/src/transport/nostr-server-transport.ts:461) with `e=<requestEventId>`.
- Verify settlement using the selected `PaymentProcessor`.
- Emit `notifications/payment_accepted` (also correlated by `e`).
- Only then forward the request to the underlying MCP server.

## PMI selection and prioritization

Recommended selection strategy:

1. If the request includes one or more `pmi` tags, select the first PMI (client priority order) that the server supports.
2. Otherwise (no PMI advertised), the server MAY emit multiple `payment_required` notifications, but the SDK SHOULD default to emitting a single method if possible to reduce invoice churn.

This matches CEP-8 guidance and keeps behavior deterministic.

## Plan of record (implementation sequence)

1. **Transport fix:** support correlated notifications on the client.
2. **Extensibility:** add outbound tag hook on the client transport.
3. **Payment middleware (server):** implement processor registry + flow that emits `payment_required`, verifies, emits `payment_accepted`, then forwards.
4. **Payment middleware (client):** implement handler registry + flow that executes handler on `payment_required`, and optionally observes `payment_accepted`.
5. **Tests:**
   - unit: correlated notification routing in the client transport
   - integration: paid request flow end-to-end using a mock payment processor/handler (no real LN/Cashu needed)
6. **First real PMI module:** implement one concrete rail (e.g., `bitcoin-lightning-bolt11`) behind the interfaces.

## Testing approach (what “done” looks like)

- A client receives a `notifications/payment_required` that contains `e=<requestEventId>` and it is delivered to the application layer as a notification (not mis-cast as a response).
- The client can attach `pmi` tags to the request without modifying transport internals.
- The server emits `notifications/payment_accepted` and the client observes it as a signed receipt.
- Retried publication of the same request event id does not cause multiple charges (server-side idempotency policy).