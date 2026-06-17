import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCErrorResponse,
  JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';
import { createExplicitGatingMiddleware } from './server-explicit-gating.js';
import type { ServerPaymentsContext } from './types.js';
import { AuthorizationStore } from './authorization-store.js';
import {
  PAYMENT_PENDING_ERROR_CODE,
  PAYMENT_REQUIRED_ERROR_CODE,
} from './constants.js';

describe('Explicit Gating Middleware', () => {
  const processor = {
    pmi: 'fake',
    async createPaymentRequired(params: {
      amount: number;
      description?: string;
      requestEventId: string;
      clientPubkey: string;
    }) {
      return {
        amount: params.amount,
        pay_req: 'pay_req',
        description: params.description,
        pmi: 'fake',
        ttl: 300,
        _meta: { test: true },
      };
    },
    async verifyPayment() {
      return { _meta: { ok: true } };
    },
  };

  const pricedCapabilities = [
    {
      method: 'tools/call',
      name: 'add',
      amount: 10,
      currencyUnit: 'test',
      description: 'listed',
    },
  ] as const;

  const ctx: ServerPaymentsContext = {
    clientPubkey: 'test-client',
    paymentInteraction: 'explicit_gating',
  };

  const message: JSONRPCRequest = {
    jsonrpc: '2.0',
    id: 'event-id',
    method: 'tools/call',
    params: { name: 'add', arguments: { a: 1, b: 2 } },
  };

  test('emits -32042 Payment Required on first request', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    let forwarded = false;
    await mw(message, ctx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(false);
    expect(sentResponses.length).toBe(1);

    const response = sentResponses[0];
    expect(response.error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);

    const data = response.error.data as {
      payment_options: { amount: number; pay_req: string }[];
    };
    expect(data.payment_options.length).toBe(1);
    expect(data.payment_options[0].amount).toBe(10);
    expect(data.payment_options[0].pay_req).toBe('pay_req');
  });

  test('forwards request directly if client is using legacy transparent mode', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    let forwarded = false;
    const legacyCtx = { ...ctx, paymentInteraction: 'transparent' as const };
    await mw(message, legacyCtx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(true);
    expect(sentResponses.length).toBe(0);
  });

  test('emits -32043 Payment Pending if already pending', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    await mw(message, ctx, async () => {});
    await mw(message, ctx, async () => {}); // Second call should be pending

    expect(sentResponses.length).toBe(2);
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
    expect(sentResponses[1].error.code).toBe(PAYMENT_PENDING_ERROR_CODE);
  });

  test('forwards request if authorization is granted', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    // We fake the authorization grant
    // The canonical identity depends on the method and params
    // JCS of { method: "tools/call", params: { name: "add", arguments: { a: 1, b: 2 } } }
    // We can just use the utility to compute it
    const { computeCanonicalInvocationIdentity } =
      await import('./canonical-identity.js');
    const identity = computeCanonicalInvocationIdentity(
      ctx.clientPubkey,
      message.method,
      message.params,
    );
    store.grant(identity, 10000);

    let forwarded = false;
    await mw(message, ctx, async () => {
      forwarded = true;
    });

    expect(sentResponses.length).toBe(0);
    expect(forwarded).toBe(true);

    // Auth should be consumed, second call should trigger payment required
    let forwarded2 = false;
    await mw(message, ctx, async () => {
      forwarded2 = true;
    });

    expect(forwarded2).toBe(false);
    expect(sentResponses.length).toBe(1);
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
  });

  test('forwards request directly if resolvePrice waives payment', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
        resolvePrice: async () => ({ waive: true }),
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    let forwarded = false;
    await mw(message, ctx, async () => {
      forwarded = true;
    });

    expect(sentResponses.length).toBe(0);
    expect(forwarded).toBe(true);
  });

  test('rejects request immediately if resolvePrice rejects', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
        resolvePrice: async () => ({ reject: true, message: 'Rate limited' }),
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response as JSONRPCErrorResponse);
      },
    });

    let forwarded = false;
    await mw(message, ctx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(false);
    expect(sentResponses.length).toBe(1);
    expect(sentResponses[0].error.code).toBe(-32000);
    expect(sentResponses[0].error.message).toBe('Rate limited');
  });
});
