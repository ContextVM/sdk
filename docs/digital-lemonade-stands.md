# Digital Lemonade Stands: CEP-8 Payments Land in ContextVM

The internet is full of “capabilities” hiding behind toll booths.

You can publish software that other people (or agents) can call, but getting paid usually means stepping back into the old world: accounts, gatekeepers, geography, and payment rails that don’t compose.

ContextVM set out to change the *shape* of collaboration: services addressed by public keys, routed over relays, and usable in a stateless way. We’ve written before about why that matters for censorship-resistance and sovereign infrastructure.

Now we’re adding the missing economic primitive.

**CEP-8 (Capability Pricing and Payment Flow) makes “digital lemonade stands” real**: paid, permissionless capabilities that can be run by anyone, discovered by anyone, and consumed by humans or agents—without a centralized registry and without forcing a single payment system on the entire ecosystem.

“Lemonade stand” doesn’t mean “toy.” It means *sovereign commerce at the edge*: the ability to expose anything from a single tool to a serious production service, and get paid per interaction, without asking anyone for permission.

This post is an announcement, not a full guide. The goal is to explain *why* CEP-8 looks the way it does, what it unlocks, and how the SDK integrates payments without bloating transports or breaking existing deployments.

## The core idea: paid, structured interaction—without permission

When people hear “payments,” they often imagine a monolith: one platform, one processor, one set of rules. That model doesn’t survive contact with the real world.

Real networks are messy:

- some calls are stateful, some are stateless
- some providers want fixed prices, others want dynamic quotes
- some payment methods are invoice-based, others are bearer assets
- relays can duplicate or reorder messages
- there are a lot of different payment methods

CEP-8 embraces this chaos instead of hiding it.

It gives ContextVM a **minimal, robust lifecycle** for paid capability invocations, and it does so in a way that preserves the permissionless nature of the protocol.

The mechanism has three pillars:

1. **Discovery pricing (`cap` tags)**: servers can advertise *reference* prices for capabilities.
2. **Compatibility negotiation (`pmi` tags)**: clients and servers advertise which payment methods they can speak.
3. **A notification flow**: the server requests payment, the client pays, the server verifies, then the request is fulfilled.

All of that is specified in [CEP-8](contextvm-docs/src/content/docs/spec/ceps/cep-8.md).

## PMIs are “universal settlement plug-ins”

The most important design decision in CEP-8 is that **the payment request itself is opaque**.

The protocol doesn’t standardize “Lightning invoices,” “Cashu proofs,” “credit card sessions,” or whatever comes next. Instead, CEP-8 standardizes *how to ask for payment*, *how to correlate it to the call*, and *how to agree on the language of settlement*.

That language is the **Payment Method Identifier (PMI)**. Based on the W3C standard with the same name.

In CEP-8 terms:

- `pmi` is the type tag.
- `pay_req` is the payload.
- the meaning of `pay_req` is **PMI-defined**.

This is deliberately similar to the way the web uses content-types: you don’t need to standardize every possible payload, you need a reliable way to say *“interpret this blob as X.”*

Together with CEP-8 we added CEP-21, which provides recommended PMI naming conventions for the ContextVM ecosystem, but it’s explicitly non-normative: you can define your own PMIs when you need new semantics. See [CEP-21](contextvm-docs/src/content/docs/spec/ceps/informational/cep-21.md).

### Matching by intersection (how payment rails stay permissionless)

PMIs make payments composable because selection is just compatibility matching:

- clients advertise what they can pay
- servers advertise what they can accept
- the payment rail is chosen from the **intersection**

That’s not “supporting one payment method.” It’s a matching mechanism that lets many payment methods coexist without fragmenting the protocol.

This matters for resilience: in a permissionless environment, you don’t want a payment monopoly baked into the protocol.

## The CEP-8 lifecycle: small semantics, big consequences

Once a capability is priced, CEP-8 defines a simple lifecycle:

1) client calls a capability

2) server responds with a payment required notification

3) client pays using a handler for the specified PMI

4) server verifies settlement and emits payment accepted or payment rejected notifications

5) server fulfills the request


This is how you get a payment flow that survives the real world.

### Direct bearer payments (saving round trips)

Some payment methods are bearer assets, think about cashu for example: value can be transferred by attaching a token directly in the request, saving round trips.

CEP-8 includes an optional optimization for this: the `direct_payment` tag. When a PMI supports it, the client can attach a PMI-scoped payload on the original request and skip the invoice round trip.

## Why this matters: the economics of permissionless services

If you remove centralized identity, centralized discovery, and centralized hosting constraints, you get something powerful—but it still doesn’t sustain itself without an economic loop.

CEP-8 closes that loop in a way that matches ContextVM’s philosophy:

- **no registry required** to monetize a capability
- **no platform account required** to pay or get paid
- **no single rail forced on everyone**
- **no protocol fork** required to add new settlement systems

This is how you get a world of “digital lemonade stands”: thousands of specialized capabilities, each easy to publish, easy to pay for, and easy to compose into larger workflows.

In an agent-to-agent world, this isn’t a nice-to-have. It’s the difference between a permissioned economy and an open one.

## Clear roles: processors mint, handlers pay

CEP-8 is deliberately explicit about roles, because it keeps implementations honest and keeps the protocol surface small:

- **Server = payment processor**: it *mints* a payment request (`pay_req`) for a quote, and later *verifies* that settlement happened.
- **Client = payment handler**: it *interprets* the `pay_req` (based on `pmi`) and performs the wallet action.

Everything else—how an invoice is created, how settlement is proved, which third-party system is involved—is PMI-scoped and intentionally outside the CEP.

## The SDK: payments as middleware, not as a transport rewrite

We implemented CEP-8 in the TypeScript SDK with one strong constraint: **payments must be optional and must not bloat transports**.

That’s why the integration is middleware-first:

- transports keep doing transport things (Nostr event conversion, routing, encryption, correlation)
- payments wrap the message flow at the seam where requests are forwarded

This allowed us to add paid capabilities without introducing breaking changes. If you don’t enable payments, you shouldn’t pay a performance or complexity tax.

The SDK exposes this through two simple wrappers:

- `withServerPayments(...)` to gate priced capabilities on the server side
- `withClientPayments(...)` to automatically handle payment requests on the client side

### Built-in rails (same PMI, different “backend”)

The new version of the SDK ships with two real Lightning BOLT11 integrations, and they both implement the same PMI (`bitcoin-lightning-bolt11`). More integrations can be added in the future. Or you can build your own to satisfy your own needs.

That’s the point: the *PMI is the contract*, not the vendor.

- NWC (NIP-47) processor/handler (wallet-driven)
- LNbits processor/handler (service-driven)

Both satisfy the same settlement surface. Both can be swapped without changing CEP-8 semantics.

This is a concrete example of the PMI idea: **the protocol contract stays stable even as the backend changes**.

## Amounts: discovery vs settlement

CEP-8 deliberately separates **price discovery** from **settlement**.

When a server advertises pricing, it uses `cap` tags. Think of these as the *menu*: helpful for UX, browsing, and automation.

When the server requests payment, it sends `notifications/payment_required` with:

- a final `amount`
- a `pmi`
- an opaque `pay_req` that encodes the real settlement request for that PMI

The implication is subtle but powerful:

- a server can advertise prices in `usd` for clarity
- and still settle in sats when the chosen PMI is Lightning for example

The conversion and quoting logic lives in the server’s dynamic pricing callback.

## Using CEP-8 in the SDK (compact examples)

These snippets are intentionally lightweight and partially pseudo-code. The goal is to show the *mechanics* without turning this post into a tutorial.

### 1) Server: fixed pricing + payments gate

Configure which capabilities are priced, then wrap the transport.

```ts
import {
  withServerPayments,
  LnBolt11NwcPaymentProcessor,
  type PricedCapability,
} from '@contextvm/sdk/payments';
import { NostrServerTransport } from '@contextvm/sdk/transport';

const pricedCapabilities: PricedCapability[] = [
  {
    method: 'tools/call',
    name: 'your_tool',
    amount: 10,
    currencyUnit: 'sats',
    description: 'Example paid capability',
  },
];

const baseTransport = new NostrServerTransport({ signer, relayHandler });

const paidTransport = withServerPayments(baseTransport, {
  processors: [
    new LnBolt11NwcPaymentProcessor({
      // ... NWC connection details
    }),
    // Or swap for LNbits without changing CEP-8 semantics.
  ],
  pricedCapabilities,
});
```

What matters here isn’t the wallet backend. It’s that the server has a processor that can mint and verify a payment request for the chosen PMI, and the payments layer will fail closed: no paid capability gets forwarded before settlement.

### 2) Server: dynamic pricing + currency conversion with `resolvePrice`

Fixed prices are a demo. Real services need quoting.

The SDK supports a per-request quote callback: [`ResolvePriceFn`](src/payments/types.ts:137).

```ts
import {
  withServerPayments,
  type ResolvePriceFn,
} from '@contextvm/sdk/payments';

const resolvePrice: ResolvePriceFn = async ({ capability, request }) => {
  // Pseudo-logic: a real quote often depends on the request.
  // Example: charge more for larger inputs, *and* allow advertising in USD while settling in sats.

  const inputSize = JSON.stringify(request.params ?? {}).length;
  const units = Math.max(1, Math.ceil(inputSize / 1_000));

  // Start from the advertised price.
  const advertised = capability.amount * units;

  // If you advertise in USD for UX, convert here before minting a sats-based invoice.
  const amount =
    capability.currencyUnit === 'usd'
      ? await convertUsdToSats(advertised)
      : advertised;

  return amount
};

const paidTransport = withServerPayments(baseTransport, {
  processors: [processor],
  pricedCapabilities,
  resolvePrice,
});
```

This is a subtle but important CEP-8 principle: **`cap` tags are discovery**, while the payment required amount is the final quote. You can publish a “menu” in one unit and still settle in another.

### 3) Client: pay automatically when required

The client wraps its transport with [`withClientPayments()`](src/payments/client-payments.ts:32) and provides one or more handlers.

```ts
import {
  withClientPayments,
  LnBolt11LnbitsPaymentHandler,
  LnBolt11NwcPaymentHandler,
} from '@contextvm/sdk/payments';
import { NostrClientTransport } from '@contextvm/sdk/transport';

const baseTransport = new NostrClientTransport({ signer, relayHandler, serverPubkey });

const paidTransport = withClientPayments(baseTransport, {
  handlers: [
    new LnBolt11NwcPaymentHandler({
      // ... NWC connection details
    }),
    // Other handlers can be added.
  ],
});
```

The important part: when payments are enabled, the client automatically advertises its supported PMIs to help the server pick a compatible method.

## What to build now

CEP-8 isn’t “payments added.” It’s **a sustainable primitive for permissionless capability markets**.

If you’re building on ContextVM, there are three obvious next steps:

1) **Price one capability** in an existing server—make it a real lemonade stand.

2) **Build a client that can pay** (or an agent that can pay) and start composing paid capabilities into workflows.

3) **Implement a new PMI** if your settlement method isn’t covered yet. CEP-8 is designed for pluralism: new rails should not require new transports.

Specifications:

- [CEP-8](contextvm-docs/src/content/docs/spec/ceps/cep-8.md)
- [CEP-21](contextvm-docs/src/content/docs/spec/ceps/informational/cep-21.md)

Implementation notes (SDK architecture):

- [Payments design notes](docs/payments.md)

SDK usage guide (follow-up, deeper walkthrough):

- [Paid servers and clients](docs/payments-paid-servers-and-clients.md)

The frontier is open. Build a stand. Price a capability. Let value flow where computation happens.
