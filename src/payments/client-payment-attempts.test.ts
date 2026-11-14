import { describe, expect, test } from 'bun:test';
import { ClientPaymentAttempts } from './client-payment-attempts.js';
import { option } from '../__mocks__/client-payments-harness.js';

describe('client payment attempt retention under capacity pressure', () => {
  for (const outcome of ['handled', 'declined'] as const) {
    test(`evicts ${outcome} history least recently used first`, () => {
      const attempts = new ClientPaymentAttempts(2);
      const signal = new AbortController().signal;
      const first = attempts.reserve([option('first')], signal);
      first.complete(outcome);
      const second = attempts.reserve([option('second')], signal);
      second.complete(outcome);

      expect(attempts.find([option('first')])).toBe(first);
      const third = attempts.reserve([option('third')], signal);
      expect(attempts.find([option('first')])).toBe(first);
      expect(attempts.find([option('second')])).toBeUndefined();
      expect(attempts.find([option('third')])).toBe(third);
      third.complete(outcome);
    });
  }

  test('skips in-flight and unknown pins when evicting older history', () => {
    const attempts = new ClientPaymentAttempts(3);
    const signal = new AbortController().signal;
    const inFlight = attempts.reserve([option('pending')], signal);
    const unknown = attempts.reserve([option('unknown')], signal);
    unknown.complete('unknown');
    const handled = attempts.reserve([option('handled')], signal);
    handled.complete('handled');

    const replacement = attempts.reserve([option('replacement')], signal);
    expect(attempts.find([option('handled')])).toBeUndefined();
    expect(attempts.find([option('pending')])).toBe(inFlight);
    expect(attempts.find([option('unknown')])).toBe(unknown);
    expect(attempts.find([option('replacement')])).toBe(replacement);
    inFlight.complete('handled');
    replacement.complete('handled');
  });

  test('refuses atomically when a multi-option reservation cannot fit beside pins', () => {
    const attempts = new ClientPaymentAttempts(2);
    const signal = new AbortController().signal;
    const unknown = attempts.reserve([option('unknown')], signal);
    unknown.complete('unknown');
    const handled = attempts.reserve([option('handled')], signal);
    handled.complete('handled');

    expect(() =>
      attempts.reserve([option('new-one'), option('new-two')], signal),
    ).toThrow(expect.objectContaining({ reason: 'payment_attempt_capacity' }));
    expect(attempts.find([option('unknown')])).toBe(unknown);
    expect(attempts.find([option('handled')])).toBe(handled);
    expect(
      attempts.find([option('new-one'), option('new-two')]),
    ).toBeUndefined();
  });

  test('pins every distinct option of an in-flight or unknown explicit attempt', async () => {
    const attempts = new ClientPaymentAttempts(2);
    const controller = new AbortController();
    const attempt = attempts.reserve(
      [option('one'), option('one'), option('two')],
      controller.signal,
    );
    expect(attempts.find([option('one')])).toBe(attempt);
    expect(attempts.find([option('two')])).toBe(attempt);
    expect(() =>
      attempts.reserve([option('three')], controller.signal),
    ).toThrow(expect.objectContaining({ reason: 'payment_attempt_capacity' }));

    controller.abort();
    await attempt.completion;
    attempt.complete('handled');
    expect(attempt.outcome).toBe('unknown');
    expect(() =>
      attempts.reserve([option('three')], new AbortController().signal),
    ).toThrow(expect.objectContaining({ reason: 'payment_attempt_capacity' }));
    expect(attempts.find([option('one')])).toBe(attempt);
    expect(attempts.find([option('two')])).toBe(attempt);
  });

  test('reclaims enough terminal identities for a multi-option reservation', () => {
    const attempts = new ClientPaymentAttempts(2);
    const signal = new AbortController().signal;
    const prior = attempts.reserve([option('one'), option('two')], signal);
    prior.complete('declined');
    const next = attempts.reserve([option('three'), option('four')], signal);
    expect(attempts.find([option('one'), option('two')])).toBeUndefined();
    expect(attempts.find([option('three')])).toBe(next);
    expect(attempts.find([option('four')])).toBe(next);
    next.complete('handled');
  });
});
