import { describe, expect, test } from 'bun:test';
import {
  assertBolt11Amount,
  Bolt11ValidationError,
  decodeBolt11,
} from './bolt11.js';
import {
  BOLT11_SPEC_INVALID,
  BOLT11_SPEC_TIMESTAMP,
  BOLT11_SPEC_VALID,
  testBolt11,
} from '../__mocks__/bolt11-fixtures.js';

const reason = (run: () => unknown): string | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof Bolt11ValidationError ? error.reason : 'other';
  }
};

describe('BOLT11 decoding against specification vectors', () => {
  test('decodes network, amount, timestamp, and expiry from published vectors', () => {
    expect(decodeBolt11(BOLT11_SPEC_VALID.amountless)).toEqual({
      network: 'bitcoin',
      timestamp: BOLT11_SPEC_TIMESTAMP,
      expirySeconds: 3600,
    });
    expect(decodeBolt11(BOLT11_SPEC_VALID.oneMinute)).toEqual({
      network: 'bitcoin',
      amountMsats: 250_000_000,
      timestamp: BOLT11_SPEC_TIMESTAMP,
      expirySeconds: 60,
    });
    expect(decodeBolt11(BOLT11_SPEC_VALID.testnet)).toMatchObject({
      network: 'testnet',
      amountMsats: 2_000_000_000,
    });
    expect(decodeBolt11(BOLT11_SPEC_VALID.pico)).toEqual({
      network: 'bitcoin',
      amountMsats: 967_878_534,
      timestamp: 1_572_468_703,
      expirySeconds: 604_800,
    });
    expect(decodeBolt11(BOLT11_SPEC_VALID.upperCase)).toMatchObject({
      amountMsats: 2_500_000_000,
    });
  });

  for (const [name, invoice] of Object.entries(BOLT11_SPEC_INVALID)) {
    test(`rejects the published invalid vector: ${name}`, () => {
      expect(reason(() => decodeBolt11(invoice))).toBe('invalid');
    });
  }

  test('rejects non-invoice payloads without throwing unrelated errors', () => {
    for (const input of [
      '',
      'lnbc1',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    ])
      expect(reason(() => decodeBolt11(input))).toBe('invalid');
  });
});

describe('BOLT11 binding to an approved amount', () => {
  test('[F09] expiry boundary: valid before, expired at and after timestamp + expiry', () => {
    const expiresAtMs = (BOLT11_SPEC_TIMESTAMP + 60) * 1000;
    const check = (nowMs: number): string | undefined =>
      reason(() =>
        assertBolt11Amount(BOLT11_SPEC_VALID.oneMinute, {
          amountSats: 250_000,
          nowMs,
        }),
      );
    expect(check(expiresAtMs - 1)).toBeUndefined();
    expect(check(expiresAtMs)).toBe('expired');
    expect(check(expiresAtMs + 1)).toBe('expired');
  });

  test('[F07] refuses wrong-amount, amountless, and wrong-network invoices', () => {
    const invoice = testBolt11({ sats: 21, expirySeconds: 600 });
    expect(reason(() => assertBolt11Amount(invoice, { amountSats: 21 }))).toBe(
      undefined,
    );
    expect(reason(() => assertBolt11Amount(invoice, { amountSats: 20 }))).toBe(
      'amount',
    );
    expect(
      reason(() => assertBolt11Amount(testBolt11({}), { amountSats: 21 })),
    ).toBe('amount');
    expect(
      reason(() =>
        assertBolt11Amount(testBolt11({ sats: 21, network: 'tb' }), {
          amountSats: 21,
          network: 'bitcoin',
        }),
      ),
    ).toBe('network');
    expect(
      reason(() =>
        assertBolt11Amount(testBolt11({ sats: 21, network: 'bcrt' }), {
          amountSats: 21,
          network: 'regtest',
        }),
      ),
    ).toBeUndefined();
  });
});
