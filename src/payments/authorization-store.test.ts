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

  test('grant multiple executions', () => {
    const store = new AuthorizationStore();
    
    store.grant(identity, 10000, 2);
    
    expect(store.claim(identity)).toBe(true);
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
    
    // hasPending should reflect the state
    expect(store.hasPending(identity)).toBe(true);
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
    
    store.trySetPending(identity, 10000);
    expect(store.hasPending(identity)).toBe(true);
    
    store.grant(identity, 10000);
    
    expect(store.hasPending(identity)).toBe(false);
    expect(store.claim(identity)).toBe(true);
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
});
