import { describe, expect, test } from 'bun:test';
import { parseClientPaymentRequired } from './client-payment-validation.js';

describe('client payment validation budgets', () => {
  test('[F11] the payment_options size budget applies before any element is inspected', () => {
    let inspected = 0;
    const option = {
      get amount(): number {
        inspected++;
        return 1;
      },
      pmi: 'test-rail',
      pay_req: 'invoice',
    };
    expect(() =>
      parseClientPaymentRequired({
        payment_options: new Array(1000).fill(option),
      }),
    ).toThrow('Invalid payment message');
    expect(inspected).toBe(0);
  });
});
