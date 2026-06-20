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

  // Also covers the -32043 window during verify and single-use grant consumption.
  test('exercises async verifyPayment → grant → claim → forward on retry', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];

    let verifyResolve!: () => void;
    const verifyGate = new Promise<void>((resolve) => {
      verifyResolve = resolve;
    });
    let verifyCount = 0;
    const asyncProcessor = {
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
        };
      },
      async verifyPayment() {
        verifyCount += 1;
        await verifyGate;
        return { _meta: { ok: true } };
      },
    };

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [asyncProcessor],
        pricedCapabilities: [...pricedCapabilities],
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    // (1) First request: -32042 emitted, verifyPayment started but unresolved.
    let forwarded1 = false;
    await mw(message, ctx, async () => {
      forwarded1 = true;
    });
    expect(forwarded1).toBe(false);
    expect(sentResponses).toHaveLength(1);
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
    expect(verifyCount).toBe(1);

    // (2) Retry while verify is still in flight: -32043 (pending), no forward.
    let forwarded2 = false;
    await mw(message, ctx, async () => {
      forwarded2 = true;
    });
    expect(forwarded2).toBe(false);
    expect(sentResponses).toHaveLength(2);
    expect(sentResponses[1].error.code).toBe(PAYMENT_PENDING_ERROR_CODE);

    // (3) Release verifyPayment → middleware grants authorization.
    verifyResolve();
    await new Promise((r) => setTimeout(r, 5));

    // (4) Retry now: claim consumes the grant → forward, no new response.
    let forwarded3 = false;
    await mw(message, ctx, async () => {
      forwarded3 = true;
    });
    expect(forwarded3).toBe(true);
    expect(sentResponses).toHaveLength(2);

    // (5) Authorization is single-use: next call needs a fresh payment.
    let forwarded4 = false;
    await mw(message, ctx, async () => {
      forwarded4 = true;
    });
    expect(forwarded4).toBe(false);
    expect(sentResponses).toHaveLength(3);
    expect(sentResponses[2].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
  });

  test('clears pending and returns fresh -32042 when verifyPayment rejects', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];
    let createCount = 0;
    const rejectingProcessor = {
      pmi: 'fake',
      async createPaymentRequired(params: {
        amount: number;
        requestEventId: string;
        clientPubkey: string;
      }) {
        createCount += 1;
        return {
          amount: params.amount,
          pay_req: `pr-${createCount}`,
          pmi: 'fake',
          ttl: 300,
        };
      },
      async verifyPayment() {
        throw new Error('settlement failed');
      },
    };

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [rejectingProcessor],
        pricedCapabilities: [...pricedCapabilities],
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    await mw(message, ctx, async () => {});
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);

    // Let the async verifyPayment reject and clear pending state.
    await new Promise((r) => setTimeout(r, 5));

    // Retry: fresh -32042 (not -32043) with a brand-new payment request.
    await mw(message, ctx, async () => {});
    expect(sentResponses).toHaveLength(2);
    expect(sentResponses[1].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
    expect(createCount).toBe(2);
  });

  // Timeout-path counterpart to the test above.
  test('clears pending and returns fresh -32042 when verifyPayment times out', async () => {
    const store = new AuthorizationStore();
    const sentResponses: JSONRPCErrorResponse[] = [];
    let createCount = 0;
    const timeoutProcessor = {
      pmi: 'fake',
      async createPaymentRequired(params: {
        amount: number;
        requestEventId: string;
        clientPubkey: string;
      }) {
        createCount += 1;
        return {
          amount: params.amount,
          pay_req: `pr-${createCount}`,
          pmi: 'fake',
          ttl: 1,
        };
      },
      verifyPayment() {
        return new Promise<{ _meta?: Record<string, unknown> }>(() => {
          // never resolves
        });
      },
    };

    const mw = createExplicitGatingMiddleware({
      options: {
        processors: [timeoutProcessor],
        pricedCapabilities: [...pricedCapabilities],
        // Cap the polling timeout so the test stays fast.
        paymentTtlMs: 200,
      },
      authorizationStore: store,
      sendResponse: async (_pubkey, response) => {
        sentResponses.push(response);
      },
    });

    await mw(message, ctx, async () => {});
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);

    // Wait for the verify timeout (~200ms) + clearPending.
    await new Promise((r) => setTimeout(r, 300));

    // Retry: fresh -32042 (not -32043).
    await mw(message, ctx, async () => {});
    expect(sentResponses).toHaveLength(2);
    expect(sentResponses[1].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
    expect(createCount).toBe(2);
  });
});
