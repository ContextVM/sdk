import { describe, expect, test } from 'bun:test';
import { AuthorizationStore } from './authorization-store.js';
import { paymentStoreContract } from '../__mocks__/payment-store-contract.js';

paymentStoreContract('in-memory atomic payment store', async (policy) => {
  let now = Date.now();
  const store = new AuthorizationStore(policy, () => now);
  return {
    store,
    peer: store,
    advance: async (ms) => {
      now += ms;
    },
    close: async () => {},
  };
});

describe('payment store configuration', () => {
  test('rejects invalid capacity/retention settings', () => {
    for (const value of [-1, NaN, Infinity, 1.5]) {
      expect(
        () => new AuthorizationStore({ maxPendingPayments: value }),
      ).toThrow();
      expect(
        () => new AuthorizationStore({ maxPaymentRecords: value }),
      ).toThrow();
    }
    expect(() => new AuthorizationStore({ replayWindowMs: 0 })).toThrow();
  });
});

test('clock rollback cannot readmit a collected event', async () => {
  let now = 1000000;
  const store = new AuthorizationStore({ replayWindowMs: 1000 }, () => now);
  const input = {
    key: '["event","client","event"]',
    mode: 'transparent' as const,
    clientPubkey: 'client',
    requestEventId: 'event',
    invocationHash: 'hash',
    leaseMs: 100,
    event: { id: 'event', author: 'client', createdAt: 1000 },
  };
  const admitted = await store.admit(input);
  expect(admitted.status).toBe('reserved');
  const generation = admitted.record!.generation;
  await store.transition({ key: input.key, generation, type: 'consume' });
  await store.transition({ key: input.key, generation, type: 'dispatch' });
  now += 1001;
  expect((await store.admit(input)).status).toBe('stale');
  expect(await store.read(input.key)).toBeUndefined();
  now -= 1001;
  expect((await store.admit(input)).status).toBe('stale');
});
