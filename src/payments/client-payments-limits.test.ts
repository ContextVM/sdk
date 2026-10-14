import { describe, expect, test } from 'bun:test';
import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import { withClientPayments } from './client-payments.js';
import type { PaymentOption } from './types.js';
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

describe('client payment limits and validation', () => {
  test('replacement invoices share an attempt allowance', async () => {
    let calls = 0;
    await run(
      {
        limits: { maxAttempts: 1 },
        onPaymentRequired: async () => {
          calls++;
          return { paid: true };
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => h.sent.length === 2);
        h.deliver(required(1, [option('replacement')]));
        await waitFor(() => failures(h).length === 1);
        expect(calls).toBe(1);
        expect(failures(h)[0]?.error.data).toMatchObject({
          reason: 'payment_limit_exceeded',
        });
      },
    );
  });

  test('replacement invoices share a cumulative per-PMI amount limit', async () => {
    let calls = 0;
    await run(
      {
        limits: { maxAmountByPmi: { fake: 8 } },
        onPaymentRequired: async () => {
          calls++;
          return { paid: true };
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => h.sent.length === 2);
        h.deliver(required(1, [option('replacement', 4)]));
        await waitFor(() => failures(h).length === 1);
        expect(calls).toBe(1);
      },
    );
  });

  test('multi-option offers reserve a conservative maximum per PMI and exclude unlisted rails', async () => {
    const approved: PaymentOption[][] = [];
    await run(
      {
        limits: { maxAmountByPmi: { fake: 10 } },
        onPaymentRequired: async ({ options }) => {
          approved.push(options);
          return { paid: true };
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(
          required(1, [
            option('low', 2),
            option('high', 8),
            option('other', 1, 'other'),
          ]),
        );
        await waitFor(() => h.sent.length === 2);
        expect(approved[0]).toEqual([option('low', 2), option('high', 8)]);
        h.deliver(required(1, [option('replacement', 3)]));
        await waitFor(() => failures(h).length === 1);
        expect(approved).toHaveLength(1);
      },
    );
  });

  test('limits are independent for genuinely new invocations', async () => {
    let calls = 0;
    await run(
      {
        limits: { maxAttempts: 1, maxAmountByPmi: { fake: 5 } },
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
        h.deliver(required(2, [option('independent')]));
        await waitFor(() => calls === 2);
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('zero limits refuse wallet work before policy approval', async () => {
    let policies = 0;
    let payments = 0;
    await run(
      {
        limits: { maxAttempts: 0 },
        paymentPolicy: () => {
          policies++;
          return true;
        },
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
        await waitFor(() => failures(h).length === 1);
        expect(policies).toBe(0);
        expect(payments).toBe(0);
      },
    );
  });

  test('deadline aborts awaiting approval and prevents a later retry', async () => {
    const decision = deferred<{ paid: boolean }>();
    let signal: AbortSignal | undefined;
    await run(
      {
        limits: { timeoutMs: 10 },
        onPaymentRequired: async ({ abortSignal }) => {
          signal = abortSignal;
          return decision.promise;
        },
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(required());
        await waitFor(() => failures(h).length === 1);
        expect(signal?.aborted).toBe(true);
        decision.resolve({ paid: true });
        await wait(10);
        expect(h.sent).toHaveLength(1);
        expect(failures(h)).toHaveLength(1);
        expect(failures(h)[0]?.error.data).toMatchObject({
          reason: 'payment_deadline_exceeded',
        });
      },
    );
  });

  for (const invalid of [
    { ...option(), amount: -1 },
    { ...option(), amount: NaN },
    { ...option(), amount: Infinity },
    { ...option(), amount: Number.MAX_SAFE_INTEGER + 1 },
    { ...option(), amount: '5' },
    { ...option(), pmi: 'INVALID:PMI' },
    { ...option(), pay_req: '' },
    { ...option(), pay_req: '   ' },
    { ...option(), ttl: 0 },
    { ...option(), ttl: -1 },
    { ...option(), ttl: Infinity },
    { ...option(), _meta: [] },
    null,
  ]) {
    test(`rejects malformed transparent offer ${JSON.stringify(invalid)}`, async () => {
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
          h.deliver(offer(invalid));
          await waitFor(() => failures(h).length === 1);
          expect(calls).toBe(0);
          expect(failures(h)[0]?.error.data).toMatchObject({
            reason: 'invalid_payment',
          });
        },
      );
    });
  }

  for (const invalid of [
    [],
    [option(), { ...option('invalid'), amount: -1 }],
    [option(), option('invoice', 6)],
  ]) {
    test(`validates every explicit option ${JSON.stringify(invalid)}`, async () => {
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
          h.deliver(required(1, invalid));
          await waitFor(() => failures(h).length === 1);
          expect(calls).toBe(0);
        },
      );
    });
  }

  for (const invalid of [-1, NaN, Infinity, '1', null]) {
    test(`invalid retry hint ${String(invalid)} cannot schedule a send`, async () => {
      await run({}, async (h) => {
        await h.paid.send(request());
        h.deliver(pending(1, invalid));
        await waitFor(() => failures(h).length === 1);
        await wait(5);
        expect(h.sent).toHaveLength(1);
      });
    });
  }

  test('omitted retry hint uses a finite default delay', async () => {
    await run({}, async (h) => {
      await h.paid.send(request());
      h.deliver(pending());
      await waitFor(() => h.sent.length === 2, { timeoutMs: 1500 });
      expect(failures(h)).toHaveLength(0);
    });
  });

  test('unknown metadata is preserved without influencing validation', async () => {
    let metadata: unknown;
    await run(
      {
        handlers: [
          {
            pmi: 'fake',
            async handle(req): Promise<void> {
              metadata = req._meta;
            },
          },
        ],
      },
      async (h) => {
        await h.paid.send(request());
        h.deliver(
          offer({
            ...option(),
            _meta: { custom: { future: true } },
            extra: 'ignored',
          }),
        );
        await waitFor(() => metadata !== undefined);
        expect(metadata).toEqual({ custom: { future: true } });
        expect(failures(h)).toHaveLength(0);
      },
    );
  });

  test('ambiguous uncorrelated notifications never choose between concurrent requests', async () => {
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
        await h.paid.send(request(2));
        h.deliver(offer());
        await tick();
        expect(calls).toBe(0);
        expect(h.errors).toHaveLength(1);
      },
    );
  });

  for (const options of [
    { minRetryDelayMs: -1 },
    { minRetryDelayMs: NaN },
    { maxPendingRetries: 0.5 },
    { maxTrackedPaymentAttempts: -1 },
    { syntheticProgressIntervalMs: 0 },
    { limits: { timeoutMs: 0 } },
    { limits: { timeoutMs: 2_147_483_648 } },
    { limits: { maxAttempts: -1 } },
    { limits: { maxAmountByPmi: { fake: Infinity } } },
  ]) {
    test(`configuration validation rejects ${JSON.stringify(options)} before wrapping`, () => {
      const base: Transport = {
        async start(): Promise<void> {},
        async send(): Promise<void> {},
        async close(): Promise<void> {},
      };
      expect(() => withClientPayments(base, options)).toThrow(
        'Invalid client payment options',
      );
      expect(() => withClientPayments(base, {})).not.toThrow();
    });
  }
});
