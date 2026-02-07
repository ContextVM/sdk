---
title: Payments Guide
description: How to implement CEP-8 payments in your Nostr MCP server and client
---

# Payments Guide

This guide explains how to implement CEP-8 payments in your Nostr MCP applications. CEP-8 defines a protocol for charging clients for specific capabilities (tools, prompts, resources) using payment method identifiers (PMIs).

## Overview

The payment flow works as follows:

1. **Server advertises** pricing via `cap` tags and supported payment methods via `pmi` tags
2. **Client requests** a priced capability
3. **Server responds** with `notifications/payment_required` containing payment details
4. **Client pays** using the appropriate payment handler for the PMI
5. **Server verifies** payment and emits `notifications/payment_accepted`
6. **Server processes** the original request

## Server Setup

### 1. Define Priced Capabilities

```typescript
import { PricedCapability } from './src/payments/types.js';

const pricedCapabilities: PricedCapability[] = [
  {
    method: 'tools/call',
    name: 'expensiveAnalysis',
    amount: 1000,
    currencyUnit: 'sats',
    description: 'Advanced data analysis tool',
  },
  {
    method: 'resources/read',
    name: 'premium://content',
    amount: 100,
    currencyUnit: 'sats',
  },
  // Price ranges are supported via maxAmount
  {
    method: 'tools/call',
    name: 'variablePricing',
    amount: 100,
    maxAmount: 1000,
    currencyUnit: 'sats',
  },
];
```

### 2. Implement a Payment Processor

```typescript
import { PaymentProcessor } from './src/payments/types.js';

class LightningProcessor implements PaymentProcessor {
  readonly pmi = 'bitcoin-lightning-bolt11';

  async createPaymentRequired(params) {
    // Create an invoice via your Lightning node
    const invoice = await createInvoice({
      amount: params.amount,
      description: params.description,
    });

    return {
      amount: params.amount,
      pay_req: invoice.bolt11,
      description: params.description,
      pmi: this.pmi,
      ttl: 300, // 5 minutes in seconds (CEP-8 spec)
    };
  }

  async verifyPayment(params) {
    // Poll or subscribe to payment status
    const receipt = await waitForPayment(params.pay_req);
    return { receipt };
  }
}
```

### 3. Attach Payments to Server Transport

```typescript
import { NostrServerTransport } from './src/transport/nostr-server-transport.js';
import { withServerPayments } from './src/payments/server-transport-payments.js';

const transport = new NostrServerTransport({
  signer,
  relayHandler,
  // ... other options
});

// Attach payment gating
withServerPayments(transport, {
  processors: [new LightningProcessor()],
  pricedCapabilities,
  paymentTtlMs: 300_000, // 5 minutes default

  // Optional: dynamic per-request pricing (final quote used for payment_required).
  resolvePrice: async ({ capability, request, clientPubkey, requestEventId }) => {
    // Example: charge more for larger inputs or based on client tier.
    // `capability.amount` remains the advertised/reference price.
    const amount = capability.amount;
    return {
      amount,
      description: capability.description,
      meta: { clientPubkey, method: request.method },
    };
  },
});

await transport.start();
```

## Client Setup

### 1. Implement a Payment Handler

```typescript
import { PaymentHandler } from './src/payments/types.js';

class LightningHandler implements PaymentHandler {
  readonly pmi = 'bitcoin-lightning-bolt11';

  async canHandle(req) {
    // Optional: check if wallet has sufficient balance
    return await checkBalance(req.amount);
  }

  async handle(req) {
    // Pay the invoice using your Lightning wallet
    await payInvoice(req.pay_req);
    console.log(`Paid ${req.amount} sats for ${req.requestEventId}`);
  }
}
```

### 2. Attach Payments to Client Transport

```typescript
import { NostrClientTransport } from './src/transport/nostr-client-transport.js';
import { withClientPayments } from './src/payments/client-payments.js';

const baseTransport = new NostrClientTransport({
  signer,
  relayHandler,
  serverPubkey,
  // ... other options
});

// Wrap with automatic payment handling
const transport = withClientPayments(baseTransport, {
  handlers: [new LightningHandler()],
});

const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(transport);

// Now tool calls that require payment are handled automatically
const result = await client.callTool({
  name: 'expensiveAnalysis',
  arguments: { data: '...' },
});
```

## Key Concepts

### Payment Method Identifiers (PMIs)

PMIs identify payment methods. Common examples:
- `bitcoin-lightning-bolt11` - Lightning Network BOLT11 invoices
- `bitcoin-onchain` - Bitcoin on-chain addresses
- `fake` - Test processor for development

### Correlation

All payment notifications include an `e` tag referencing the original request event ID. This enables:
- Client handlers to correlate payments with requests
- Server idempotency (same request ID = single charge)
- Audit trails and debugging

### Idempotency

The server middleware ensures:
- Duplicate request event IDs don't result in double charges
- Concurrent duplicates await the same in-flight payment
- Verification timeouts are bounded by TTL (default 5 minutes)

### Client-Side Dedupe

The client wrapper automatically deduplicates concurrent `payment_required` notifications with the same `pay_req`, preventing accidental double payments.

## Testing

Use the fake processor and handler for development:

```typescript
import { FakePaymentProcessor } from './src/payments/fake-payment-processor.js';
import { FakePaymentHandler } from './src/payments/fake-payment-handler.js';

// Server
withServerPayments(transport, {
  processors: [new FakePaymentProcessor({ verifyDelayMs: 100 })],
  pricedCapabilities,
});

// Client
const transport = withClientPayments(baseTransport, {
  handlers: [new FakePaymentHandler({ delayMs: 50 })],
});
```

## Reference

- [CEP-8 Specification](./cep-8.md)
- [Payments Architecture](./payments-architecture.md)
- Type definitions: [`src/payments/types.ts`](../src/payments/types.ts)
