import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCErrorResponse,
  JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';
import { createExplicitGatingMiddleware } from './server-explicit-gating.js';
import type { ServerPaymentsContext } from './types.js';
import { AuthorizationStore } from './authorization-store.js';
import { computeCanonicalInvocationIdentity } from './canonical-identity.js';
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

  // --- CEP-8 explicit-gating security invariants ---
  // A paid grant authorizes exactly one execution of one specific invocation
  // by one specific client. The canonical identity is SHA-256(JCS({method,
  // params})) scoped to the client pubkey; the JSON-RPC id MUST NOT affect it.
  // These tests lock each isolation axis at the middleware level.

  test('grant for one param set does not authorize a different param set', async () => {
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

    // Grant authorization for add({ a: 1, b: 2 }).
    store.grant(
      computeCanonicalInvocationIdentity(
        ctx.clientPubkey,
        message.method,
        message.params,
      ),
      10000,
    );

    // Different params: add({ a: 9, b: 9 }).
    const otherMessage: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'event-id',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 9, b: 9 } },
    };

    let forwarded = false;
    await mw(otherMessage, ctx, async () => {
      forwarded = true;
    });

    // The grant for {a:1,b:2} must NOT authorize {a:9,b:9}.
    expect(forwarded).toBe(false);
    expect(sentResponses).toHaveLength(1);
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);

    // The original grant is still consumable by its own params.
    let forwardedOriginal = false;
    await mw(message, ctx, async () => {
      forwardedOriginal = true;
    });
    expect(forwardedOriginal).toBe(true);
    expect(sentResponses).toHaveLength(1);
  });

  test('grant for one client does not authorize a different client', async () => {
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

    // Grant authorization scoped to 'test-client'.
    store.grant(
      computeCanonicalInvocationIdentity(
        ctx.clientPubkey,
        message.method,
        message.params,
      ),
      10000,
    );

    // Same method + params, but a different client pubkey.
    const otherCtx: ServerPaymentsContext = {
      ...ctx,
      clientPubkey: 'other-client',
    };

    let forwarded = false;
    await mw(message, otherCtx, async () => {
      forwarded = true;
    });

    // The grant for 'test-client' must NOT authorize 'other-client'.
    expect(forwarded).toBe(false);
    expect(sentResponses).toHaveLength(1);
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);

    // The original client can still consume its grant.
    let forwardedOriginal = false;
    await mw(message, ctx, async () => {
      forwardedOriginal = true;
    });
    expect(forwardedOriginal).toBe(true);
    expect(sentResponses).toHaveLength(1);
  });

  test('grant matches across different JSON-RPC ids (id is not part of identity)', async () => {
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

    // Identity is computed from method + params only; the original request's
    // id ('event-id') is intentionally excluded from the canonical form.
    store.grant(
      computeCanonicalInvocationIdentity(
        ctx.clientPubkey,
        message.method,
        message.params,
      ),
      10000,
    );

    // Retry with a DIFFERENT JSON-RPC id but identical method + params.
    const retryWithDifferentId: JSONRPCRequest = {
      ...message,
      id: 'a-completely-different-event-id',
    };

    let forwarded = false;
    await mw(retryWithDifferentId, ctx, async () => {
      forwarded = true;
    });

    // The grant must still match despite the different id.
    expect(forwarded).toBe(true);
    expect(sentResponses).toHaveLength(0);
  });

  test('grant matches across different params._meta.progressToken (_meta excluded from identity)', async () => {
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

    // Identity is computed from method + semantic params only; `params._meta`
    // (MCP's reserved transport/extension namespace, incl. progressToken) is
    // excluded from the canonical form. The MCP client SDK regenerates
    // progressToken on every callTool, so a retry/re-invoke carries a fresh
    // token — this locks that retries still match a paid grant.
    const paramsWithMeta = (progressToken: number): JSONRPCRequest => ({
      ...message,
      params: {
        ...message.params,
        _meta: { progressToken },
      },
    });

    // Grant authorization for the invocation carrying progressToken 1.
    store.grant(
      computeCanonicalInvocationIdentity(
        ctx.clientPubkey,
        message.method,
        paramsWithMeta(1).params,
      ),
      10000,
    );

    // Retry with a DIFFERENT progressToken (2) but identical semantic params.
    let forwarded = false;
    await mw(paramsWithMeta(2), ctx, async () => {
      forwarded = true;
    });

    // The grant must still match despite the different progressToken.
    expect(forwarded).toBe(true);
    expect(sentResponses).toHaveLength(0);
  });

  test('concurrent requests after a grant: exactly one consumes it, the other is gated', async () => {
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

    // A single grant is available for this invocation.
    store.grant(
      computeCanonicalInvocationIdentity(
        ctx.clientPubkey,
        message.method,
        message.params,
      ),
      10000,
    );

    let forwards = 0;
    const forward = async () => {
      forwards += 1;
    };

    // Fire two concurrent middleware calls for the same invocation.
    await Promise.all([mw(message, ctx, forward), mw(message, ctx, forward)]);

    // Exactly one consumes the single-use grant and forwards; the other is
    // gated with a fresh -32042. claim() is synchronous, so the first call
    // to reach it always wins deterministically.
    expect(forwards).toBe(1);
    expect(sentResponses).toHaveLength(1);
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
  });

  test('expired grant yields a fresh -32042 instead of forwarding', async () => {
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

    // Grant authorization with a very short TTL.
    store.grant(
      computeCanonicalInvocationIdentity(
        ctx.clientPubkey,
        message.method,
        message.params,
      ),
      50,
    );

    // Wait past the grant TTL so it expires before the retry arrives.
    await new Promise((r) => setTimeout(r, 75));

    // The stale grant must NOT authorize the request: the middleware should
    // treat it as unpaid and emit a fresh -32042 rather than forwarding.
    let forwarded = false;
    await mw(message, ctx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(false);
    expect(sentResponses).toHaveLength(1);
    expect(sentResponses[0].error.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);
  });

  test('non-priced capability passes through ungated in explicit gating mode', async () => {
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

    // A tool NOT listed in pricedCapabilities (only 'add' is priced).
    const unpricedMessage: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'event-id',
      method: 'tools/call',
      params: { name: 'free', arguments: {} },
    };

    let forwarded = false;
    await mw(unpricedMessage, ctx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(true);
    expect(sentResponses).toHaveLength(0);
  });
});
