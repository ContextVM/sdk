import { describe, expect, test } from 'bun:test';
import type { PaymentProcessorVerifyParams } from './types.js';
import { FakePaymentProcessor } from './fake-payment-processor.js';

const verifyParams = (
  overrides: Partial<PaymentProcessorVerifyParams> = {},
): PaymentProcessorVerifyParams => ({
  pay_req: 'r',
  requestEventId: 'evt',
  clientPubkey: 'pk',
  ...overrides,
});

describe('FakePaymentProcessor', () => {
  test('createPaymentRequired builds a deterministic pay_req and passes ttl', async () => {
    const processor = new FakePaymentProcessor({ ttl: 600 });
    const out = await processor.createPaymentRequired({
      amount: 42,
      description: 'd',
      requestEventId: 'evt',
      clientPubkey: 'pk',
    });
    expect(out.pay_req).toBe('fake:evt:pk:42');
    expect(out.amount).toBe(42);
    expect(out.pmi).toBe('fake');
    expect(out.ttl).toBe(600);
    expect(out.description).toBe('d');
  });

  test('verifyPayment settles after the delay when no signal is given', async () => {
    const processor = new FakePaymentProcessor({ verifyDelayMs: 0 });
    const out = await processor.verifyPayment(verifyParams());
    expect(out._meta).toEqual({ settled: true });
  });

  test('a pre-aborted signal rejects immediately and never settles', async () => {
    const processor = new FakePaymentProcessor({ verifyDelayMs: 1000 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      processor.verifyPayment(verifyParams({ abortSignal: controller.signal })),
    ).rejects.toThrow();
  });

  test('aborting mid-verify rejects before the delay completes', async () => {
    // 1000 ms settle; abort at ~5 ms must reject well before 1000 ms.
    const processor = new FakePaymentProcessor({ verifyDelayMs: 1000 });
    const controller = new AbortController();
    const promise = processor.verifyPayment(
      verifyParams({ abortSignal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 5);
    const start = Date.now();
    await expect(promise).rejects.toThrow();
    // Sanity: rejected near-immediately, not after the full settle delay.
    expect(Date.now() - start).toBeLessThan(500);
  });
});
