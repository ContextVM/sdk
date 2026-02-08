---
title: Paid Servers and Clients (CEP-8)
description: How to build paid ContextVM servers and clients with CEP-8 payments, including NWC (NIP-47) Lightning BOLT11
---

# Paid Servers and Clients (CEP-8)

This post shows how to build **paid** ContextVM servers and clients using the SDK’s CEP-8 payments layer.

If you can already run a server and connect a client over Nostr, you’re one wrapper away from charging for specific capabilities.

## What “paid” means in CEP-8

CEP-8 introduces a simple contract:

- A server can mark specific capabilities as priced.
- When the client calls a priced capability, the server replies with `notifications/payment_required`.
- A client-side payment handler pays the opaque `pay_req`.
- The server verifies and emits `notifications/payment_accepted`, then fulfills the original request.

The SDK implements this as a middleware layer so you don’t have to re-architect your transports.

## The two plugin types you configure

On purpose, the SDK only asks you for two things:

1) A **server-side payment processor** (creates + verifies payment requests)
2) A **client-side payment handler** (executes payments)

Both are keyed by a Payment Method Identifier (PMI), e.g. `bitcoin-lightning-bolt11`.

At a high level:

- A **processor** creates `pay_req` and later verifies it.
- A **handler** receives `pay_req` and pays it.

## Built-in payment rail: Lightning BOLT11 over NWC (NIP-47)

Today the SDK ships a real payment rail:

- Processor: [`LnBolt11NwcPaymentProcessor`](src/payments/processors/ln-bolt11-nwc-payment-processor.ts:35)
- Handler: [`LnBolt11NwcPaymentHandler`](src/payments/handlers/ln-bolt11-nwc-payment-handler.ts:20)

These implement PMI [`PMI_BITCOIN_LIGHTNING_BOLT11`](src/payments/pmis.ts:1) (value: `bitcoin-lightning-bolt11`).

NWC uses a connection string of the form `nostr+walletconnect://...`.

## PMI matching (how a payment rail is chosen)

Think of PMI selection as a compatibility match:

- The client advertises one or more PMIs it can pay.
- The server advertises one or more PMIs it can accept.
- A payment can only proceed if there is an **intersection**.

If there is no matching PMI, the server can’t issue a usable `pay_req`, so the call cannot be paid.

## Amount conventions (read this once, avoid confusion forever)

CEP-8 deliberately separates **price discovery** from **settlement**.

- `pricedCapabilities[].amount` + `currencyUnit` are what you *advertise* in `cap` tags (think: “menu price”).
- The **PMI you end up using** determines how settlement actually happens.
- The `pay_req` is opaque on purpose: it’s the settlement payload for the chosen PMI.

That means `currencyUnit` is not required to equal the settlement currency.

Example:

- You can advertise pricing in `usd` for transparency.
- If the client and server choose PMI `bitcoin-lightning-bolt11`, you will still settle in sats because Lightning invoices encode sats/msats.
- If a future processor settles via cards, the `pay_req` could represent a card checkout session instead.

The only rule you must follow is consistency: whatever you charge, encode it in the settlement request produced by the chosen processor.

## Server: create a paid server

You’ll do three things:

1) Register your tools/resources/prompts as usual.
2) Define which ones are priced.
3) Wrap your Nostr server transport with `withServerPayments`.

### 1) Define priced capabilities (fixed price)

`pricedCapabilities` is an array of patterns.

```ts
import type { PricedCapability } from '@contextvm/sdk/payments';

const pricedCapabilities: PricedCapability[] = [
  {
    method: 'tools/call',
    name: 'add',
    amount: 10,
    currencyUnit: 'sats',
    description: 'Paid demo tool',
  },
];
```

### 2) Configure the NWC-backed processor

```ts
import {
  LnBolt11NwcPaymentProcessor,
  withServerPayments,
} from '@contextvm/sdk/payments';
import { NostrServerTransport } from '@contextvm/sdk/transport';

const processor = new LnBolt11NwcPaymentProcessor({
  nwcConnectionString: process.env.NWC_SERVER_CONNECTION!,
  // Defaults are fine for most setups; you can tune ttlSeconds/pollIntervalMs if needed.
});

const baseTransport = new NostrServerTransport({
  signer,
  relayHandler,
  // encryptionMode: ...
});

const paidTransport = withServerPayments(baseTransport, {
  processors: [processor],
  pricedCapabilities,
});
```

From here, connect your server with `paidTransport` instead of the base transport.

### 3) Dynamic pricing: `resolvePrice`

Fixed price works well for simple services. For “real” pricing—tiering, request-size pricing, promos—use `resolvePrice`.
This callback runs on the server at the payment gate and returns the **final quote**.

If your chosen processor settles in sats (Lightning), then the amount you return from `resolvePrice` must be sats.

#### Example: advertise USD, settle over Lightning

In this example, `cap` tags show USD pricing, but the server settles using Lightning BOLT11.
`resolvePrice` is responsible for doing the USD→sats conversion before the LN processor creates the invoice.

```ts
import type { PricedCapability, ResolvePriceFn } from '@contextvm/sdk/payments';

const pricedCapabilitiesUsd: PricedCapability[] = [
  {
    method: 'tools/call',
    name: 'add',
    amount: 0.01,
    currencyUnit: 'usd',
    description: 'Paid demo tool (USD advertised, LN settled)',
  },
];

async function convertUsdToSats(usd: number): Promise<number> {
  // Use your preferred FX source. Keep this function deterministic and cached in production.
  const satsPerUsd = 10_000;
  return Math.max(1, Math.round(usd * satsPerUsd));
}

const resolvePrice: ResolvePriceFn = async ({ capability }) => {
  if (capability.currencyUnit === 'usd') {
    return {
      amount: await convertUsdToSats(capability.amount),
      description: capability.description,
    };
  }

  // If you're already advertising sats (or other units you treat as sats), pass-through.
  return { amount: capability.amount, description: capability.description };
};

const paidTransport = withServerPayments(baseTransport, {
  processors: [processor],
  pricedCapabilities: pricedCapabilitiesUsd,
  resolvePrice,
});
```

Important: the `cap` tags a server advertises are a discovery surface; `resolvePrice` defines what you actually charge.

## Client: create a paying client

The client config mirrors the server:

1) Create a handler for a PMI.
2) Wrap your client transport with `withClientPayments`.
3) (Recommended) advertise your supported PMIs by injecting `pmi` tags.

### 1) Configure the NWC handler

```ts
import {
  LnBolt11NwcPaymentHandler,
  createClientPmiOutboundTagHook,
  withClientPayments,
} from '@contextvm/sdk/payments';
import { NostrClientTransport } from '@contextvm/sdk/transport';

const handler = new LnBolt11NwcPaymentHandler({
  nwcConnectionString: process.env.NWC_CLIENT_CONNECTION!,
});

const baseTransport = new NostrClientTransport({
  signer,
  relayHandler,
  serverPubkey,
  outboundTagHook: createClientPmiOutboundTagHook([handler]),
});

const paidTransport = withClientPayments(baseTransport, {
  handlers: [handler],
});
```

Once connected, calls like `client.callTool({ name: 'add', arguments: { ... } })` will automatically pay when required.

## A minimal end-to-end example (server + client)

The repo includes end-to-end NWC demo tests that wire everything together

## Practical notes

### Defaults you can rely on

- You do not need to configure optional timeouts/polling unless you’re integrating with a particularly slow relay/wallet.
- If you do tune, do it on the NWC handler/processor options, not in your business logic.

## Create your own payment rail (custom PMI)

The real power of CEP-8 is that you can plug in any settlement mechanism without changing your server/client message flow.

### Custom server processor

Implement a processor that can:

- Create a settlement request (`pay_req`) for a quote.
- Verify settlement later and produce an optional receipt.

Example sketch (pseudo-code):

```ts
class CreditCardProcessor {
  pmi = 'credit-card-checkout';

  async createPaymentRequired({ amount, description }) {
    const session = await createCheckoutSession({ amount, description });
    return {
      amount,
      pmi: this.pmi,
      pay_req: session.url,
      ttl: 300,
    };
  }

  async verifyPayment({ pay_req }) {
    const receipt = await waitForSessionPaid(pay_req);
    return { receipt };
  }
}
```

### Custom client handler

Implement a handler that knows how to execute the settlement request produced by your processor.

```ts
class CreditCardHandler {
  pmi = 'credit-card-checkout';

  async handle({ pay_req }) {
    // e.g. open a browser window, deep-link to a mobile flow, etc.
    await openCheckout(pay_req);
  }
}
```

Once both sides share a PMI, the rest of your code stays the same.
