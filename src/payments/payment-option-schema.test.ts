import { expect, test } from 'bun:test';
import {
  parseClientPaymentOption,
  validateClientPaymentOptions,
} from './client-payment-validation.js';
import {
  validateProcessorPayment,
  validateServerPaymentOptions,
} from './server-payment-validation.js';
import { resolvePaymentProcessor } from './server-payments-utils.js';
import type { PaymentProcessor } from './types.js';

function processor(pmi: string): PaymentProcessor {
  return {
    pmi,
    async createPaymentRequired() {
      return { amount: 1, pmi, pay_req: 'invoice' };
    },
    async verifyPayment() {
      return {};
    },
  };
}

for (const pmi of [
  'bitcoin-lightning-bolt11',
  'https://wallet.example/method',
  'pmi:A',
  'x'.repeat(2048),
]) {
  test(`PMIs match exactly across client and server boundaries (${pmi.slice(0, 45)}, length=${pmi.length})`, () => {
    const rail = processor(pmi);
    const option = { amount: 1, pmi, pay_req: 'invoice' };
    expect(parseClientPaymentOption(option)).toEqual(option);
    expect(() =>
      validateClientPaymentOptions({
        handlers: [{ pmi, async handle() {} }],
        limits: { maxAmountByPmi: { [pmi]: 1 } },
      }),
    ).not.toThrow();
    expect(() =>
      validateServerPaymentOptions({
        processors: [rail],
        pricedCapabilities: [],
      }),
    ).not.toThrow();
    expect(validateProcessorPayment(option, rail, 1)).toEqual(option);
    expect(resolvePaymentProcessor([pmi], new Map([[pmi, rail]]), [rail])).toBe(
      rail,
    );
    expect(() =>
      resolvePaymentProcessor([`${pmi}-different`], new Map([[pmi, rail]]), [
        rail,
      ]),
    ).toThrow();
  });
}

for (const pmi of ['', 'x'.repeat(2049)]) {
  test(`PMI bounds apply to every client and server boundary (length=${pmi.length})`, () => {
    const rail = processor(pmi);
    const option = { amount: 1, pmi, pay_req: 'invoice' };
    expect(() => parseClientPaymentOption(option)).toThrow();
    expect(() =>
      validateClientPaymentOptions({ handlers: [{ pmi, async handle() {} }] }),
    ).toThrow();
    expect(() =>
      validateClientPaymentOptions({
        limits: { maxAmountByPmi: { [pmi]: 1 } },
      }),
    ).toThrow();
    expect(() =>
      validateServerPaymentOptions({
        processors: [rail],
        pricedCapabilities: [],
      }),
    ).toThrow();
    expect(() => validateProcessorPayment(option, rail, 1)).toThrow();
    expect(() =>
      resolvePaymentProcessor([pmi], new Map([[pmi, rail]]), [rail]),
    ).toThrow();
  });
}
