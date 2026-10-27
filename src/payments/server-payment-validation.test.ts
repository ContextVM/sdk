import { describe, expect, test } from 'bun:test';
import type { JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import { createServerPaymentsMiddleware } from './server-payments.js';
import {
  resolveAndInitiatePayment,
  resolvePaymentProcessor,
} from './server-payments-utils.js';
import {
  validateServerPaymentOptions,
  validateServerQuote,
} from './server-payment-validation.js';
import { InMemoryPaymentStateStore } from './in-memory-payment-state-store.js';
import type { PaymentProcessor, ResolvePriceResult } from './types.js';

const priced = {
  method: 'tools/call',
  amount: 10,
  maxAmount: 20,
  currencyUnit: 'sats',
};
const message: JSONRPCRequest = {
  jsonrpc: '2.0',
  id: 'event',
  method: 'tools/call',
  params: { name: 'paid', arguments: { x: 1 }, _meta: { progressToken: 3 } },
};
const processor: PaymentProcessor = {
  pmi: 'fake',
  currencyUnit: 'sats',
  async createPaymentRequired(input) {
    return { pmi: 'fake', pay_req: 'invoice', amount: input.amount };
  },
  async verifyPayment() {
    return {};
  },
};

function initiate(
  override: {
    quote?: unknown;
    processor?: PaymentProcessor;
    clientPmis?: string[];
  } = {},
): ReturnType<typeof resolveAndInitiatePayment> {
  const rail = override.processor ?? processor;
  return resolveAndInitiatePayment({
    message,
    priced,
    requestEventId: 'event',
    clientPubkey: 'client',
    clientPmis: override.clientPmis,
    options: {
      processors: [rail],
      resolvePrice: async () =>
        (override.quote ?? { amount: 10 }) as ResolvePriceResult,
    },
    processorsByPmi: new Map([[rail.pmi, rail]]),
  });
}

describe('server payment boundary validation', () => {
  test('inclusive quote endpoints are valid; fixed quotes cannot change their advertised amount', () => {
    for (const amount of [10, 15, 20])
      expect(
        validateServerQuote({ amount, currencyUnit: 'sats' }, priced),
      ).toMatchObject({ amount });
    expect(() =>
      validateServerQuote({ amount: 11 }, { ...priced, maxAmount: undefined }),
    ).toThrow('advertised');
  });

  test('rejects malformed/out-of-range quotes and changed units before processor work', async () => {
    let calls = 0;
    const rail = {
      ...processor,
      async createPaymentRequired() {
        calls++;
        throw new Error('unexpected invoice');
      },
    };
    for (const quote of [
      { amount: -1 },
      { amount: NaN },
      { amount: Infinity },
      { amount: 9 },
      { amount: 21 },
      { amount: 10, currencyUnit: 'msats' },
      { amount: 10, meta: [] },
      { rejected: true },
      { waive: true, amount: 10 },
      { amount: 10, meta: { fn: () => {} } },
    ])
      await expect(initiate({ processor: rail, quote })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('rejects incompatible native processor units before invoice creation', async () => {
    await expect(
      initiate({ processor: { ...processor, currencyUnit: 'msats' } }),
    ).rejects.toThrow('unit');
  });

  test('rejects mismatched or malformed processor output', async () => {
    for (const invoice of [
      { amount: 11, pmi: 'fake', pay_req: 'invoice' },
      { amount: 10, pmi: 'other', pay_req: 'invoice' },
      { amount: 10, pmi: 'fake', pay_req: '' },
      { amount: 10, pmi: 'fake', pay_req: '   ' },
      { amount: 10, pmi: 'INVALID:PMI', pay_req: 'invoice' },
      { amount: 10, pmi: 'fake', pay_req: 'invoice', ttl: 0 },
      { amount: 10, pmi: 'fake', pay_req: 'invoice', ttl: NaN },
      { amount: 10, pmi: 'fake', pay_req: 'invoice', _meta: { fn: () => {} } },
    ])
      await expect(
        initiate({
          processor: {
            ...processor,
            async createPaymentRequired() {
              return invoice;
            },
          },
        }),
      ).rejects.toThrow();
  });

  test('honors advertised PMI preference, refuses disjoint sets, and permits absent PMIs', () => {
    const second = { ...processor, pmi: 'second' };
    const map = new Map([
      [processor.pmi, processor],
      [second.pmi, second],
    ]);
    expect(
      resolvePaymentProcessor(['unknown', 'second', 'fake'], map, [
        processor,
        second,
      ]),
    ).toBe(second);
    expect(resolvePaymentProcessor(undefined, map, [processor, second])).toBe(
      processor,
    );
    expect(() =>
      resolvePaymentProcessor(['unsupported'], map, [processor]),
    ).toThrow('mutually');
    expect(() => resolvePaymentProcessor([], map, [processor])).toThrow(
      'mutually',
    );
  });

  test('disjoint PMI sets never reach invoice creation', async () => {
    let invoices = 0;
    await expect(
      initiate({
        clientPmis: ['unsupported'],
        processor: {
          ...processor,
          async createPaymentRequired() {
            invoices++;
            throw new Error('unexpected');
          },
        },
      }),
    ).rejects.toThrow('mutually');
    expect(invoices).toBe(0);
  });

  test('invalid configuration and injected-store policy mismatch are rejected synchronously', () => {
    const base = { processors: [processor], pricedCapabilities: [priced] };
    for (const config of [
      { paymentTtlMs: 0 },
      { paymentTtlMs: Infinity },
      { authorizationTtlMs: -1 },
      { maxPendingPayments: -1 },
      { maxPaymentRecords: 1.5 },
      { replayWindowMs: 0 },
    ])
      expect(() =>
        validateServerPaymentOptions({ ...base, ...config }),
      ).toThrow();
    for (const capability of [
      { ...priced, amount: NaN },
      { ...priced, maxAmount: 9 },
      { ...priced, currencyUnit: '' },
    ])
      expect(() =>
        validateServerPaymentOptions({
          ...base,
          pricedCapabilities: [capability],
        }),
      ).toThrow();
    expect(() =>
      validateServerPaymentOptions({
        ...base,
        stateStore: new InMemoryPaymentStateStore({ maxPendingPayments: 1 }),
        maxPendingPayments: 2,
      }),
    ).toThrow('mismatch');
  });

  test('pricing cannot change the dispatched semantic arguments or metadata', async () => {
    const original = {
      ...message,
      params: {
        name: 'paid',
        arguments: { x: 1 },
        _meta: { progressToken: 3 },
      },
    };
    const middleware = createServerPaymentsMiddleware({
      sender: { sendNotification: async () => {} },
      options: {
        processors: [processor],
        pricedCapabilities: [priced],
        resolvePrice: async ({ request, capability }) => {
          (request.params!.arguments as { x: number }).x = 999;
          request.params!._meta!.progressToken = 100;
          capability.amount = 500;
          return { waive: true };
        },
      },
    });
    let forwarded: unknown;
    await middleware(original, { clientPubkey: 'client' }, async (value) => {
      forwarded = value;
    });
    expect(forwarded).toBe(original);
    expect(original.params).toEqual({
      name: 'paid',
      arguments: { x: 1 },
      _meta: { progressToken: 3 },
    });
    expect(priced.amount).toBe(10);
  });
});
