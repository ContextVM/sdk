import { describe, expect, test } from 'bun:test';
import { AuthorizationStore } from './authorization-store.js';
import type { CanonicalInvocationIdentity } from './types.js';

describe('AuthorizationStore', () => {
  const identity: CanonicalInvocationIdentity = {
    clientPubkey: 'client-1',
    invocationHash: 'hash-1',
  };

  test('grant and claim a single authorization', () => {
    const store = new AuthorizationStore();

    expect(store.claim(identity)).toBe(false);

    store.grant(identity, 10000);

    expect(store.claim(identity)).toBe(true);
    expect(store.claim(identity)).toBe(false);
  });

  test('claim fails after TTL expires', async () => {
    const store = new AuthorizationStore();

    store.grant(identity, 50);

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(store.claim(identity)).toBe(false);
  });

  test('trySetPending prevents concurrent duplicates', () => {
    const store = new AuthorizationStore();

    // First call transitions to pending -> true
    expect(store.trySetPending(identity, 10000)).toBe(true);

    // Second call is blocked -> false
    expect(store.trySetPending(identity, 10000)).toBe(false);

    // Pending state is observable via getPendingRemainingMs
    expect(store.getPendingRemainingMs(identity)).toBeGreaterThan(0);
  });

  test('trySetPending allows setting again after clearPending', () => {
    const store = new AuthorizationStore();

    expect(store.trySetPending(identity, 10000)).toBe(true);
    expect(store.trySetPending(identity, 10000)).toBe(false);

    store.clearPending(identity);

    expect(store.trySetPending(identity, 10000)).toBe(true);
  });

  test('trySetPending allows setting again after pending state expires', async () => {
    const store = new AuthorizationStore();

    expect(store.trySetPending(identity, 50)).toBe(true);
    expect(store.trySetPending(identity, 50)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(store.trySetPending(identity, 50)).toBe(true);
  });

  test('grant clears pending state', () => {
    const store = new AuthorizationStore();

    expect(store.trySetPending(identity, 10000)).toBe(true);
    store.grant(identity, 10000);
    // grant cleared pending, so a fresh trySetPending succeeds again
    expect(store.trySetPending(identity, 10000)).toBe(true);
  });

  test('LRU eviction works when maxEntries is exceeded', () => {
    const store = new AuthorizationStore({ maxEntries: 2 });

    const id1 = { clientPubkey: 'client', invocationHash: 'h1' };
    const id2 = { clientPubkey: 'client', invocationHash: 'h2' };
    const id3 = { clientPubkey: 'client', invocationHash: 'h3' };

    store.grant(id1, 10000);
    store.grant(id2, 10000);
    store.grant(id3, 10000); // This should evict id1

    expect(store.claim(id1)).toBe(false);
    expect(store.claim(id2)).toBe(true);
    expect(store.claim(id3)).toBe(true);
  });

  test('pending entries are never evicted while live; capacity refuses instead', () => {
    const store = new AuthorizationStore({ maxEntries: 2 });

    const id1 = { clientPubkey: 'client', invocationHash: 'p1' };
    const id2 = { clientPubkey: 'client', invocationHash: 'p2' };
    const id3 = { clientPubkey: 'client', invocationHash: 'p3' };

    store.trySetPending(id1, 10000);
    store.trySetPending(id2, 10000);
    // At capacity with only live entries: refuse rather than evict — an
    // evicted live pending entry disarms the payment dedup (double charge).
    expect(store.trySetPending(id3, 10000)).toBe(false);

    expect(store.getPendingRemainingMs(id1)).toBeGreaterThan(0);
    expect(store.getPendingRemainingMs(id2)).toBeGreaterThan(0);
    expect(store.getPendingRemainingMs(id3)).toBe(0);
  });

  test('expired pending entries are purged under capacity pressure', async () => {
    const store = new AuthorizationStore({ maxEntries: 2 });

    const id1 = { clientPubkey: 'client', invocationHash: 'p1' };
    const id2 = { clientPubkey: 'client', invocationHash: 'p2' };
    const id3 = { clientPubkey: 'client', invocationHash: 'p3' };

    store.trySetPending(id1, 20);
    store.trySetPending(id2, 10000);

    await new Promise((resolve) => setTimeout(resolve, 40));

    // id1 expired: capacity pressure purges it and makes room for id3.
    expect(store.trySetPending(id3, 10000)).toBe(true);
    expect(store.getPendingRemainingMs(id1)).toBe(0);
    expect(store.getPendingRemainingMs(id2)).toBeGreaterThan(0);
    expect(store.getPendingRemainingMs(id3)).toBeGreaterThan(0);
  });

  test('hasPendingCapacity reports capacity after purging expired entries', async () => {
    const store = new AuthorizationStore({ maxEntries: 1 });

    expect(store.hasPendingCapacity()).toBe(true);

    store.trySetPending(identity, 20);
    expect(store.hasPendingCapacity()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));

    // The expired entry is purged by the capacity check itself.
    expect(store.hasPendingCapacity()).toBe(true);
    expect(store.trySetPending(identity, 10000)).toBe(true);
  });

  test('expired grants are purged before capacity-driven eviction', async () => {
    const store = new AuthorizationStore({ maxEntries: 2 });

    const id1 = { clientPubkey: 'client', invocationHash: 'g1' }; // stays live
    const id2 = { clientPubkey: 'client', invocationHash: 'g2' }; // expires
    const id3 = { clientPubkey: 'client', invocationHash: 'g3' };

    store.grant(id1, 10000);
    store.grant(id2, 20);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // id2's grant expired: purging it makes room for id3, so the LIVE id1
    // grant survives instead of being blindly evicted as the LRU victim.
    store.grant(id3, 10000);

    expect(store.claim(id1)).toBe(true);
    expect(store.claim(id2)).toBe(false);
    expect(store.claim(id3)).toBe(true);
  });

  test('updatePendingTtl and getPendingRemainingMs behave correctly', async () => {
    const store = new AuthorizationStore();

    // (1) verify getPendingRemainingMs right after trySetPending
    expect(store.trySetPending(identity, 100)).toBe(true);
    const remainingAfterSet = store.getPendingRemainingMs(identity);
    expect(remainingAfterSet).toBeGreaterThan(0);
    expect(remainingAfterSet).toBeLessThanOrEqual(100);

    // (2) verify updatePendingTtl extends the pending TTL
    store.updatePendingTtl(identity, 500);
    const remainingAfterUpdate = store.getPendingRemainingMs(identity);
    expect(remainingAfterUpdate).toBeGreaterThan(100);
    expect(remainingAfterUpdate).toBeLessThanOrEqual(500);

    // (3) verify getPendingRemainingMs returns 0 after waiting past TTL
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(store.getPendingRemainingMs(identity)).toBe(0);

    // (4) verify updatePendingTtl is a no-op when there is no active pending entry
    store.updatePendingTtl(identity, 1000);
    expect(store.getPendingRemainingMs(identity)).toBe(0);

    // And after clearPending
    store.trySetPending(identity, 1000);
    store.clearPending(identity);
    store.updatePendingTtl(identity, 1000);
    expect(store.getPendingRemainingMs(identity)).toBe(0);
  });
});
