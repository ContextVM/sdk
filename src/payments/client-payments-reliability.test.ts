import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import {
  run,
  waitFor,
  tick,
  wait,
  request,
  option,
  offer,
  required,
  pending,
  deferred,
  failures,
} from '../__mocks__/client-payments-harness.js';

describe('client payment attempt reliability', () => {
  test('retains transparent attempt history after handler return and invoice TTL', async () => {
    let calls = 0;
    await run(
      {
        handlers: [
          {
            pmi: 'fake',
            async handle(): Promise<void> {
              calls++;
            },
          },
        ],
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(offer({ ...option(), ttl: 1 }));
        await waitFor(() => calls === 1);
        await wait(1100);
        h.deliver(offer(option()));
        await tick();
        expect(calls).toBe(1);
      },
    );
  });

  test('deduplicates concurrent and sequential explicit approvals', async () => {
    let calls = 0;
    const decision = deferred<{ paid: boolean }>();
    await run(
      {
        onPaymentRequired: async () => {
          calls++;
          return decision.promise;
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        h.deliver(required());
        expect(calls).toBe(1);
        decision.resolve({ paid: true });
        await waitFor(() => h.sent.length === 2);
        h.deliver(required());
        await waitFor(() => h.sent.length === 3);
        expect(calls).toBe(1);
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('an uncertain wallet result cannot be paid again on another request id', async () => {
    let calls = 0;
    await run(
      {
        onPaymentRequired: async () => {
          calls++;
          throw new Error('wallet response lost');
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => failures(h).length === 1);
        await h.paid.send(request(2));
        h.deliver(required(2));
        await waitFor(() => failures(h).length === 2);
        expect(calls).toBe(1);
        expect(failures(h)[1]?.error.data).toMatchObject({
          reason: 'payment_outcome_unknown',
        });
      },
    );
  });

  test('different PMIs with the same opaque request remain independent', async () => {
    let calls = 0;
    await run(
      {
        handlers: ['fake', 'other'].map((pmi) => ({
          pmi,
          async handle(): Promise<void> {
            calls++;
          },
        })),
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(offer());
        await waitFor(() => calls === 1);
        h.deliver({ jsonrpc: '2.0', id: 1, result: {} });
        await h.paid.send(request(2));
        h.deliver(offer(option('invoice', 5, 'other')));
        await waitFor(() => calls === 2);
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('attempt history is isolated between stable transport peers', async () => {
    let calls = 0;
    const options = {
      handlers: [
        {
          pmi: 'fake',
          async handle(): Promise<void> {
            calls++;
          },
        },
      ],
    };
    await run(options, async (one) => {
      await run(options, async (two) => {
        await one.paid.send(request());
        await two.paid.send(request());
        one.deliver(offer());
        two.deliver(offer());
        await waitFor(() => calls === 2);
        expect(failures(one)).toHaveLength(0);
        expect(failures(two)).toHaveLength(0);
      });
    });
  });

  test('attempt capacity refuses a new invoice without forgetting a completed payment', async () => {
    let calls = 0;
    await run(
      {
        maxTrackedPaymentAttempts: 1,
        onPaymentRequired: async () => {
          calls++;
          return { paid: true };
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => h.sent.length === 2);
        h.deliver({ jsonrpc: '2.0', id: 1, result: {} });
        await h.paid.send(request(2));
        h.deliver(required(2, [option('new-invoice')]));
        await waitFor(() => failures(h).length === 1);
        expect(calls).toBe(1);
        expect(failures(h)[0]?.error.data).toMatchObject({
          reason: 'payment_attempt_capacity',
        });
        await h.paid.send(request(3));
        h.deliver(required(3));
        await waitFor(() => h.sent.length === 5);
        expect(calls).toBe(1);
      },
    );
  });

  test('changed amount for a known invoice never triggers another approval', async () => {
    let calls = 0;
    await run(
      {
        onPaymentRequired: async () => {
          calls++;
          return { paid: true };
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => h.sent.length === 2);
        h.deliver(required(1, [option('invoice', 6)]));
        await waitFor(() => failures(h).length === 1);
        expect(calls).toBe(1);
        expect(failures(h)[0]?.error.data).toMatchObject({
          reason: 'payment_offer_changed',
        });
      },
    );
  });

  test('different offers cannot run approval callbacks concurrently for one invocation', async () => {
    let calls = 0;
    const decision = deferred<{ paid: boolean }>();
    await run(
      {
        onPaymentRequired: async () => {
          calls++;
          return decision.promise;
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        h.deliver(required(1, [option('replacement')]));
        await waitFor(() => failures(h).length === 1);
        decision.resolve({ paid: true });
        await tick();
        expect(calls).toBe(1);
        expect(h.sent).toHaveLength(1);
        expect(failures(h)[0]?.error.data).toMatchObject({
          reason: 'payment_outcome_unknown',
        });
      },
    );
  });
});

test('an unknown option takes precedence over another pending payment attempt', async () => {
  const pendingDecision = deferred<{ paid: boolean }>();
  let approvals = 0;
  await run(
    {
      onPaymentRequired: async ({ options }) => {
        approvals++;
        if (options[0]?.pay_req === 'unknown')
          throw new Error('lost wallet result');
        return pendingDecision.promise;
      },
    },
    async (h) => {
      await h.paid.send(request());
      h.deliver(required(1, [option('unknown')]));
      await waitFor(() => failures(h).length === 1);
      await h.paid.send(request(2));
      h.deliver(required(2, [option('pending')]));
      await h.paid.send(request(3));
      h.deliver(required(3, [option('unknown'), option('pending')]));
      await waitFor(() => failures(h).length === 2);
      expect(failures(h)[1]?.error.data).toMatchObject({
        reason: 'payment_outcome_unknown',
      });
      expect(approvals).toBe(2);
      pendingDecision.resolve({ paid: false });
      await tick();
    },
  );
});

describe('wallet eligibility and attempt retention', () => {
  test('policy mutations cannot change the validated invoice or amount sent to a handler', async () => {
    let handled: unknown;
    await run(
      {
        paymentPolicy: (req) => {
          req.amount = 100;
          req.pay_req = 'changed';
          return true;
        },
        handlers: [
          {
            pmi: 'fake',
            async handle(req): Promise<void> {
              handled = req;
            },
          },
        ],
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(offer());
        await waitFor(() => handled !== undefined);
        expect(handled).toMatchObject(option());
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('expiry during an eligibility check prevents a wallet action', async () => {
    const eligibility = deferred<boolean>();
    let calls = 0;
    await run(
      {
        handlers: [
          {
            pmi: 'fake',
            canHandle: () => eligibility.promise,
            async handle(): Promise<void> {
              calls++;
            },
          },
        ],
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(offer({ ...option(), ttl: 0.001 }));
        await wait(10);
        eligibility.resolve(true);
        await waitFor(() => failures(h).length === 1);
        expect(calls).toBe(0);
        expect(failures(h)[0]?.error.data).toMatchObject({
          reason: 'payment_offer_expired',
        });
      },
    );
  });

  test('a failed initial send releases request state before late payment offers', async () => {
    let calls = 0;
    await run(
      {
        onPaymentRequired: async () => {
          calls++;
          return { paid: true };
        },
      },
      async (h) => {
        h.base.send = async (): Promise<void> => {
          throw new Error('publish failed');
        };
        await expect(h.paid.send(request())).rejects.toThrow('publish failed');
        h.deliver(required());
        await tick();
        expect(calls).toBe(0);
        expect(h.received).toHaveLength(0);
      },
    );
  });

  test('closed/restarted wrappers retain completed offer history', async () => {
    let calls = 0;
    await run(
      {
        onPaymentRequired: async () => {
          calls++;
          return { paid: true };
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => h.sent.length === 2);
        await h.paid.close();
        await h.paid.start();
        await h.paid.send(request(2));
        h.deliver(required(2));
        await waitFor(() => h.sent.length === 4);
        expect(calls).toBe(1);
      },
    );
  });

  test('standalone generic notifications cannot bypass per-invocation limits', async () => {
    let calls = 0;
    await run(
      {
        limits: { maxAttempts: 1 },
        handlers: [
          {
            pmi: 'fake',
            async handle(): Promise<void> {
              calls++;
            },
          },
        ],
      },
      async (h) => {
        h.deliver(offer());
        await waitFor(() => h.errors.length === 1);
        expect(calls).toBe(0);
        expect(h.errors[0]).toMatchObject({
          reason: 'payment_request_uncorrelated',
        });
      },
    );
  });

  test('zero attempt-history capacity refuses a fresh offer before approval', async () => {
    let calls = 0;
    await run(
      {
        maxTrackedPaymentAttempts: 0,
        onPaymentRequired: async () => {
          calls++;
          return { paid: true };
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => failures(h).length === 1);
        expect(calls).toBe(0);
        expect(failures(h)[0]?.error.data).toMatchObject({
          reason: 'payment_attempt_capacity',
        });
      },
    );
  });
});

describe('client payment request lifecycle', () => {
  for (const terminal of [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'done' } },
  ] as JSONRPCMessage[]) {
    test(`terminal ${'result' in terminal ? 'result' : 'error'} cancels a queued retry`, async () => {
      await run({ minRetryDelayMs: 20 }, async (h) => {
        await h.paid.send(request());
        h.deliver(pending(1, 0));
        h.deliver(terminal);
        await wait(40);
        expect(h.sent).toHaveLength(1);
        expect(h.received).toEqual([terminal]);
      });
    });
  }

  test('outbound MCP cancellation stops retries for numeric id zero only', async () => {
    await run({ minRetryDelayMs: 20 }, async (h) => {
      await h.paid.send(request(0));
      await h.paid.send(request('0'));
      h.deliver(pending(0, 0));
      h.deliver(pending('0', 0));
      await h.paid.send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 0 },
      });
      await wait(40);
      const retries = h.sent.slice(3);
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({ id: '0' });
    });
  });

  test('inbound cancellation prevents a delayed policy from starting the wallet', async () => {
    let calls = 0;
    const policy = deferred<boolean>();
    await run(
      {
        paymentPolicy: () => policy.promise,
        handlers: [
          {
            pmi: 'fake',
            async handle(): Promise<void> {
              calls++;
            },
          },
        ],
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(offer());
        h.deliver({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 1 },
        });
        policy.resolve(true);
        await tick();
        expect(calls).toBe(0);
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('close fences approval even when the underlying transport never fires onclose', async () => {
    const decision = deferred<{ paid: boolean }>();
    let signal: AbortSignal | undefined;
    await run(
      {
        onPaymentRequired: async ({ abortSignal }) => {
          signal = abortSignal;
          return decision.promise;
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await h.paid.close();
        expect(signal?.aborted).toBe(true);
        decision.resolve({ paid: true });
        await wait(10);
        expect(h.sent).toHaveLength(1);
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('terminal result fences an awaiting handler eligibility check', async () => {
    let calls = 0;
    const eligibility = deferred<boolean>();
    await run(
      {
        handlers: [
          {
            pmi: 'fake',
            canHandle: () => eligibility.promise,
            async handle(): Promise<void> {
              calls++;
            },
          },
        ],
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(offer());
        h.deliver({ jsonrpc: '2.0', id: 1, result: {} });
        eligibility.resolve(true);
        await tick();
        expect(calls).toBe(0);
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('request-id reuse does not allow the previous generation to pay or fail the replacement', async () => {
    const oldPolicy = deferred<boolean>();
    let policies = 0;
    let payments = 0;
    await run(
      {
        paymentPolicy: () => (++policies === 1 ? oldPolicy.promise : true),
        handlers: [
          {
            pmi: 'fake',
            async handle(): Promise<void> {
              payments++;
            },
          },
        ],
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(offer());
        await h.paid.send({ ...request(), params: { name: 'replacement' } });
        h.deliver(offer(option('new-invoice')));
        oldPolicy.resolve(false);
        await waitFor(() => payments === 1);
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('approval cannot mutate the cached retry invocation', async () => {
    await run(
      {
        onPaymentRequired: async ({ originalRequest }) => {
          originalRequest.id = 'changed';
          originalRequest.params = { name: 'changed' };
          return { paid: true };
        },
      },
      async (h) => {
        const original = request();
        await h.paid.send(original);
        original.params = { name: 'also-changed' };
        h.deliver(required());
        await waitFor(() => h.sent.length === 2);
        expect(h.sent[1]).toEqual(request());
      },
    );
  });

  test('duplicate pending responses queue one retry and consume one retry allowance', async () => {
    await run({ maxPendingRetries: 1, minRetryDelayMs: 20 }, async (h) => {
      await h.paid.send(request());
      h.deliver(pending(1, 0));
      h.deliver(pending(1, 0));
      await waitFor(() => h.sent.length === 2);
      expect(failures(h)).toHaveLength(0);
      h.deliver(pending(1, 0));
      expect(failures(h)).toHaveLength(1);
      await wait(30);
      expect(h.sent).toHaveLength(2);
    });
  });

  test('a retry publish failure terminates the request once', async () => {
    await run({}, async (h) => {
      await h.paid.send(request());
      h.base.send = async (): Promise<void> => {
        throw new Error('relay failed');
      };
      h.deliver(pending(1, 0));
      await waitFor(() => failures(h).length === 1);
      h.deliver(required());
      await tick();
      expect(failures(h)).toHaveLength(1);
      expect(failures(h)[0]?.error.data).toMatchObject({
        reason: 'payment_retry_failed',
      });
    });
  });
});
