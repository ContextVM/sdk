import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCErrorResponse,
  JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';
import { createExplicitGatingMiddleware } from './server-explicit-gating.js';
import { createServerPaymentsMiddleware } from './server-payments.js';
import { InMemoryPaymentStateStore } from './in-memory-payment-state-store.js';
import {
  paymentAuthorizationKey,
  paymentEventKey,
  createPaymentStatePolicy,
  type PaymentStateStore,
} from './payment-state-store.js';
import { computeCanonicalInvocationHash } from './canonical-identity.js';
import type { PaymentProcessor, ServerPaymentsContext } from './types.js';
import type { ServerPaymentsOptions } from './server-payments.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const request = (id = 'event-1'): JSONRPCRequest => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'paid', arguments: { x: 1 }, _meta: { progressToken: 7 } },
});
const context: ServerPaymentsContext = {
  clientPubkey: 'client',
  paymentInteraction: 'explicit_gating',
};
const priced = [
  { method: 'tools/call', name: 'paid', amount: 10, currencyUnit: 'sats' },
];
const authorizationKey = paymentAuthorizationKey(
  'client',
  computeCanonicalInvocationHash(request().method, request().params),
);

function processor(): PaymentProcessor {
  return {
    pmi: 'fake',
    async createPaymentRequired(input) {
      return {
        pmi: 'fake',
        amount: input.amount,
        pay_req: `invoice-${input.requestEventId}`,
      };
    },
    async verifyPayment() {
      return {};
    },
  };
}

describe('server attempt generation fences', () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`late verifier ${outcome} cannot trigger a replacement invoice or duplicate grant`, async () => {
      let now = Date.now();
      const store = new InMemoryPaymentStateStore({}, () => now);
      const old = deferred<Record<string, never>>();
      const current = deferred<Record<string, never>>();
      let invoices = 0;
      let verifications = 0;
      const base = processor();
      const replies: JSONRPCErrorResponse[] = [];
      const middleware = createExplicitGatingMiddleware({
        authorizationStore: store,
        options: {
          processors: [
            {
              ...base,
              async createPaymentRequired(input) {
                invoices++;
                return base.createPaymentRequired(input);
              },
              verifyPayment: () =>
                ++verifications === 1 ? old.promise : current.promise,
            },
          ],
          pricedCapabilities: priced,
          paymentTtlMs: 10000,
        },
        sendResponse: async (_client, response) => {
          replies.push(response);
        },
      });
      await middleware(request(), context, async () => {});
      const oldGeneration = (await store.read(authorizationKey))!.generation;
      now += 10001;
      await middleware(request('replacement'), context, async () => {});
      const replacement = (await store.read(authorizationKey))!;
      expect(replacement.generation).toBe(oldGeneration);
      if (outcome === 'resolve') old.resolve({});
      else old.reject(new Error('old failure'));
      await Bun.sleep(0);
      expect(['pending', 'unknown', 'granted']).toContain(
        (await store.read(authorizationKey))?.phase ?? 'missing',
      );
      expect((await store.read(authorizationKey))?.generation).toBe(
        replacement.generation,
      );
      expect(invoices).toBe(1);
      expect(replies.map((response) => response.error.code)).toEqual([
        -32042, -32043,
      ]);
      current.resolve({});
      await Bun.sleep(0);
      let forwards = 0;
      await middleware(request('paid-retry'), context, async () => {
        forwards++;
      });
      expect(forwards).toBe(1);
      expect(invoices).toBe(1);
    });
  }

  test('slow pricing cannot create an invoice after its reservation is replaced', async () => {
    let now = Date.now();
    const store = new InMemoryPaymentStateStore({}, () => now);
    const quote = deferred<{ amount: number }>();
    const started = deferred<undefined>();
    let quotes = 0;
    let invoices = 0;
    const base = processor();
    const verify = deferred<Record<string, never>>();
    const middleware = createExplicitGatingMiddleware({
      authorizationStore: store,
      options: {
        processors: [
          {
            ...base,
            async createPaymentRequired(input) {
              invoices++;
              return base.createPaymentRequired(input);
            },
            verifyPayment: () => verify.promise,
          },
        ],
        pricedCapabilities: priced,
        paymentTtlMs: 10000,
        resolvePrice: async () => {
          if (++quotes === 1) {
            started.resolve(undefined);
            return quote.promise;
          }
          return { amount: 10 };
        },
      },
      sendResponse: async () => {},
    });
    const first = middleware(request(), context, async () => {});
    await started.promise;
    now += 10001;
    await middleware(request('replacement'), context, async () => {});
    const generation = (await store.read(authorizationKey))!.generation;
    quote.resolve({ amount: 10 });
    await first;
    expect(invoices).toBe(1);
    expect((await store.read(authorizationKey))?.generation).toBe(generation);
    expect((await store.read(authorizationKey))?.phase).toBe('pending');
    verify.resolve({});
    await Bun.sleep(0);
  });

  test('slow invoice creation becomes uncertain without creating a replacement invoice', async () => {
    let now = Date.now();
    const store = new InMemoryPaymentStateStore({}, () => now);
    const created = deferred<{
      pmi: string;
      amount: number;
      pay_req: string;
    }>();
    const started = deferred<undefined>();
    let invoices = 0;
    const replies: JSONRPCErrorResponse[] = [];
    const middleware = createExplicitGatingMiddleware({
      authorizationStore: store,
      options: {
        processors: [
          {
            pmi: 'fake',
            async createPaymentRequired() {
              invoices++;
              started.resolve(undefined);
              return created.promise;
            },
            async verifyPayment() {
              throw new Error('Must not verify an obsolete invoice');
            },
          },
        ],
        pricedCapabilities: priced,
        paymentTtlMs: 10000,
      },
      sendResponse: async (_client, response) => {
        replies.push(response);
      },
    });
    const first = middleware(request(), context, async () => {});
    await started.promise;
    now += 10001;
    await middleware(request('replacement'), context, async () => {});
    expect(replies[0]?.error.data).toEqual({ reason: 'payment_unknown' });
    created.resolve({ amount: 10, pmi: 'fake', pay_req: 'late-invoice' });
    await first;
    expect(invoices).toBe(1);
    expect(replies).toHaveLength(1);
    expect((await store.read(authorizationKey))?.invoice?.pay_req).toBe(
      'late-invoice',
    );
    expect((await store.read(authorizationKey))?.phase).toBe('unknown');
  });
});

describe('server boundaries and transparent replay', () => {
  test('a second worker leaves verification to the live invoice owner', async () => {
    const settled = deferred<Record<string, never>>();
    const started = deferred<undefined>();
    let verifications = 0;
    let executions = 0;
    const options: ServerPaymentsOptions = {
      stateStore: new InMemoryPaymentStateStore(),
      pricedCapabilities: priced,
      processors: [
        {
          ...processor(),
          verifyPayment: () => {
            verifications++;
            started.resolve(undefined);
            return settled.promise;
          },
        },
      ],
    };
    const invoke = (): Promise<void> =>
      createServerPaymentsMiddleware({
        options,
        sender: { sendNotification: async () => {} },
      })(
        request(),
        { ...context, paymentInteraction: 'transparent' },
        async () => {
          executions++;
        },
      );
    const first = invoke();
    await started.promise;
    const second = invoke();
    await Bun.sleep(0);
    settled.resolve({});
    await Promise.all([first, second]);
    expect(verifications).toBe(1);
    expect(executions).toBe(1);
  });

  test('transparent replay beyond the invoice TTL and middleware recreation never invoices or executes twice', async () => {
    let now = Date.now();
    const store = new InMemoryPaymentStateStore({}, () => now);
    let invoices = 0;
    let executions = 0;
    const base = processor();
    const options: ServerPaymentsOptions = {
      stateStore: store,
      paymentTtlMs: 100,
      processors: [
        {
          ...base,
          async createPaymentRequired(input) {
            invoices++;
            return base.createPaymentRequired(input);
          },
        },
      ],
      pricedCapabilities: priced,
    };
    const ctx: ServerPaymentsContext = {
      clientPubkey: 'client',
      paymentInteraction: 'transparent',
      requestEvent: Object.freeze({
        id: 'event-1',
        author: 'client',
        createdAt: Math.floor(now / 1000),
      }),
    };
    const invoke = async (): Promise<void> => {
      await createServerPaymentsMiddleware({
        options,
        sender: { sendNotification: async () => {} },
      })(request(), ctx, async () => {
        executions++;
      });
    };
    await invoke();
    now += 1000;
    await invoke();
    expect(invoices).toBe(1);
    expect(executions).toBe(1);
    expect(
      (await store.read(paymentEventKey('client', 'event-1')))?.phase,
    ).toBe('dispatched');
  });

  for (const mode of ['transparent', 'explicit_gating'] as const) {
    test(`${mode}: waiver and rejection work without configured processors`, async () => {
      for (const quote of [
        { waive: true } as const,
        { reject: true, message: 'denied' } as const,
      ]) {
        const options: ServerPaymentsOptions = {
          processors: [],
          pricedCapabilities: priced,
          resolvePrice: async () => quote,
        };
        let forwarded = 0;
        let notified = 0;
        const middleware =
          mode === 'transparent'
            ? createServerPaymentsMiddleware({
                options,
                sender: {
                  sendNotification: async () => {
                    notified++;
                  },
                },
              })
            : createExplicitGatingMiddleware({
                options,
                authorizationStore: new InMemoryPaymentStateStore(),
                sendResponse: async () => {
                  notified++;
                },
              });
        await middleware(
          request(),
          { ...context, paymentInteraction: mode },
          async () => {
            forwarded++;
          },
        );
        expect(forwarded).toBe('waive' in quote ? 1 : 0);
        expect(notified).toBe('reject' in quote ? 1 : 0);
      }
    });

    test(`${mode}: backend admission failure cannot mint an invoice or dispatch`, async () => {
      const store: PaymentStateStore = {
        policy: createPaymentStatePolicy(),
        async admit() {
          throw new Error('storage unavailable');
        },
        async transition() {
          return false;
        },
        async read() {
          return undefined;
        },
      };
      let sideEffects = 0;
      const options: ServerPaymentsOptions = {
        processors: [
          {
            ...processor(),
            async createPaymentRequired() {
              sideEffects++;
              throw new Error('unexpected invoice');
            },
          },
        ],
        pricedCapabilities: priced,
        stateStore: store,
      };
      const middleware =
        mode === 'transparent'
          ? createServerPaymentsMiddleware({
              options,
              sender: { sendNotification: async () => {} },
            })
          : createExplicitGatingMiddleware({
              options,
              authorizationStore: store,
              sendResponse: async () => {},
            });
      await expect(
        middleware(
          request(),
          { ...context, paymentInteraction: mode },
          async () => {
            sideEffects++;
          },
        ),
      ).rejects.toThrow('storage unavailable');
      expect(sideEffects).toBe(0);
    });
  }
});
