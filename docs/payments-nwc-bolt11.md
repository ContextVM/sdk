---
title: NIP-47 (NWC) Payment Rail for PMI bitcoin-lightning-bolt11
description: Design + implementation notes for adding a real CEP-8 payment handler + processor backed by NIP-47 (Nostr Wallet Connect)
---

# NIP-47 (NWC) payment rail for PMI `bitcoin-lightning-bolt11`

This document is the *plan of record* for implementing the first real CEP-8 payment rail in this SDK:

- **PMI:** `bitcoin-lightning-bolt11`
- **Mechanism:** **NIP-47 / Nostr Wallet Connect (NWC)**
- **Role mapping (CEP-8):**
  - Server = *payment processor* (issues BOLT11 invoices; verifies settlement)
  - Client = *payment handler* (pays BOLT11 invoices)

It is intended to be concise but detailed enough to drive iterative implementation.

## References (in-repo)

- CEP-8 protocol spec: [`docs/cep-8.md`](docs/cep-8.md)
- Current SDK payments architecture + integration points:
  - [`docs/payments.md`](docs/payments.md)
  - [`docs/payments-architecture.md`](docs/payments-architecture.md)
- Current payments foundation (interfaces + fake modules): [`src/payments`](src/payments/index.ts:1)
- Prior art (dvmcp NWC mechanics; older protocol surface but similar NWC flow):
  - [`dvmcp/packages/dvmcp-discovery/src/nwc-payment.ts`](dvmcp/packages/dvmcp-discovery/src/nwc-payment.ts:1)

## Key insights / constraints

1) **Keep CEP-8 generic layer unchanged.**

The current CEP-8 middleware/transport integration is already correct and tested. The NWC work should be implemented strictly *behind* the existing interfaces:

- Client interface: [`PaymentHandler`](src/payments/types.ts:80)
- Server interface: [`PaymentProcessor`](src/payments/types.ts:129)
- Server gate: [`createServerPaymentsMiddleware()`](src/payments/server-payments.ts:144)
- Client wrapper: [`withClientPayments()`](src/payments/client-payments.ts:31)

2) **Deterministic minimal behavior.**

- Processor issues *one* payment request for paid calls, per current selection strategy.
- Processor verifies by polling `lookup_invoice` until `state === 'settled'` or timeout.

3) **NIP-47 method set is standardized.**

We will use the standard NIP-47 commands:

- `pay_invoice` (client handler)
- `make_invoice` + `lookup_invoice` (server processor)

4) **Units mismatch must be handled explicitly.**

- CEP-8 `amount` is treated as **sats** (SDK policy).
- NIP-47 `amount` is **msats**.

Rule: `msats = sats * 1000`.

5) **Encryption negotiation is required by NIP-47.**

- Prefer `nip44_v2`.

## Proposed repo layout (tidy)

Keep existing generic CEP-8 modules in `src/payments/*`. Add real rails and shared rail utilities under dedicated subdirectories:

- `src/payments/handlers/` — concrete client-side handlers (implements [`PaymentHandler`](src/payments/types.ts:80))
- `src/payments/processors/` — concrete server-side processors (implements [`PaymentProcessor`](src/payments/types.ts:129))
- `src/payments/nip47/` — NIP-47/NWC utilities shared by handler + processor

Additionally:

- `src/payments/pmis.ts` — PMI string constants to avoid magic values.

## Constants

Add PMI constants to avoid repeating raw strings:

```ts
export const PMI_BITCOIN_LIGHTNING_BOLT11 =
  'bitcoin-lightning-bolt11' as const;
```

All new handler/processor implementations should reference this constant.

## NIP-47/NWC connection model

NWC uses a connection URI with:

- wallet service pubkey
- one or more relay URLs
- a **client secret** (32-byte hex) used for both signing and E2E encryption

Example:

```text
nostr+walletconnect://<wallet_service_pubkey>?relay=wss%3A%2F%2Frelay.example&secret=<32-byte-hex>
```

### Relay handler reuse

Both [`LnBolt11NwcPaymentHandler`](src/payments/handlers/ln-bolt11-nwc-payment-handler.ts:21) and
[`LnBolt11NwcPaymentProcessor`](src/payments/processors/ln-bolt11-nwc-payment-processor.ts:39) accept an optional
`relayHandler`.

Do **not** share a single `relayHandler` instance between NWC and other subsystems concurrently.
This SDK's relay handler abstraction uses a *global* subscription model: calling `subscribe()` / `unsubscribe()` will
replace or cancel all active subscriptions on that handler. As a result, NWC traffic can cancel unrelated transport
subscriptions if a handler instance is shared.

### Parsing rules

- Support multiple `relay=` query params.
- Validate `secret` hex length (64 chars).
- Normalize relay URLs.

## NIP-47 encryption negotiation

### Info event (kind 13194)

Wallet service publishes a replaceable info event advertising supported methods and encryption.

We will:

1. Fetch the wallet service info event and read tag `['encryption', '...']`.
2. Choose `nip44_v2` if offered.
3. Otherwise choose `nip04`.

### Request event (kind 23194)

Requests should include:

- `['p', walletServicePubkey]`
- `['encryption', 'nip44_v2']` when using nip44
- optional `['expiration', <unix seconds>]`

### Response event (kind 23195)

Responses include:

- `['p', clientPubkey]`
- `['e', <requestEventId>]`

The encrypted payload contains:

```ts
type NwcResponse<T extends string, R> = {
  result_type: T;
  error: { code: string; message: string } | null;
  result: R | null;
};
```

## Payment rail implementations

### 1) Client: `LnBolt11NwcPaymentHandler`

Implements [`PaymentHandler`](src/payments/types.ts:80).

Responsibilities:

- On `notifications/payment_required` with `pmi=bitcoin-lightning-bolt11`:
  - interpret `pay_req` as a BOLT11 invoice
  - execute `pay_invoice` over NWC

Request payload (encrypted):

```jsonc
{
  "method": "pay_invoice",
  "params": {
    "invoice": "lnbc..."
  }
}
```

Notes:

- Client-side dedupe should remain in [`withClientPayments()`](src/payments/client-payments.ts:31) (currently dedupes by `pay_req`).
- Handler should be best-effort and must not block message delivery.

### 2) Server: `LnBolt11NwcPaymentProcessor`

Implements [`PaymentProcessor`](src/payments/types.ts:129).

#### `createPaymentRequired()`

Create an incoming invoice via NWC:

```jsonc
{
  "method": "make_invoice",
  "params": {
    "amount": 123000,
    "description": "Payment for tool execution",
    "expiry": 300
  }
}
```

Mapping to CEP-8 payment_required:

- `amount`: sats (same number as SDK quote)
- `pay_req`: the BOLT11 invoice string from NWC (`result.invoice`)
- `pmi`: `bitcoin-lightning-bolt11`
- `ttl`:
  - if `result.expires_at` present: derive `ttl = max(1, expires_at - nowSeconds)`
  - else: `ttl = options.ttlSeconds` (default 300)

#### `verifyPayment()`

Poll `lookup_invoice` until `state === 'settled'`:

```jsonc
{
  "method": "lookup_invoice",
  "params": {
    "invoice": "lnbc..."
  }
}
```

Receipt policy (default):

- Prefer `payment_hash` as CEP-8 `receipt` (avoid leaking preimages).

Timeout policy:

- Bound verification by CEP-8 TTL (seconds) as enforced in [`createServerPaymentsMiddleware()`](src/payments/server-payments.ts:243).

## Integration points (where this plugs in)

### Client

1. Construct [`NostrClientTransport`](src/transport/nostr-client-transport.ts:1).
2. Wrap with [`withClientPayments()`](src/payments/client-payments.ts:31) using `LnBolt11NwcPaymentHandler`.
3. PMI discovery tags are advertised automatically when payments are enabled.

### Server

1. Construct [`NostrServerTransport`](src/transport/nostr-server-transport.ts:1).
2. Attach payments using [`withServerPayments()`](src/payments/server-transport-payments.ts:10) configured with `LnBolt11NwcPaymentProcessor`.
3. Configure `pricedCapabilities` (reference pricing + CEP-8 cap tags).

## Testing plan (including integration tests gated by env)

### Unit tests (default)

Run by default under `bun test`:

- NWC connection string parsing (multiple relays)
- encryption negotiation selection logic (info event parsing)
- request/response correlation (`e` tag)
- handler/processor request shape validation
- polling loop behavior (lookup until settled)

### Minimal integration test (skipped by default)

Add a minimal end-to-end test that is **skipped unless an env flag is set**.

Pattern:

```ts
import { describe, test } from 'bun:test';

const nwcEnabled = process.env.NWC_INTEGRATION === 'true';

describe('nwc integration', () => {
  test.skipIf(!nwcEnabled)('pays + verifies via NWC', async () => {
    // Minimal smoke test.
  });
});
```

This keeps CI fast while allowing maintainers to run:

```sh
NWC_INTEGRATION=true bun test
```
