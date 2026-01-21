import { describe, it, expect } from 'bun:test';
import { SessionStore } from './session-store.js';

describe('SessionStore', () => {
  describe('shouldEvictSession hook', () => {
    it('should proceed with eviction when shouldEvictSession returns true', () => {
      let evictedPubkey: string | null = null;
      const store = new SessionStore({
        maxSessions: 2,
        shouldEvictSession: () => true,
        onSessionEvicted: (pubkey) => {
          evictedPubkey = pubkey;
        },
      });

      store.getOrCreateSession('client-1', false);
      store.getOrCreateSession('client-2', false);
      store.getOrCreateSession('client-3', false);

      expect(evictedPubkey!).toBe('client-1');
      expect(store.getSession('client-1')).toBeUndefined();
      expect(store.getSession('client-2')).toBeDefined();
      expect(store.getSession('client-3')).toBeDefined();
    });

    it('should prevent eviction when shouldEvictSession returns false', () => {
      const evictedKeys: string[] = [];
      const store = new SessionStore({
        maxSessions: 2,
        shouldEvictSession: () => false,
        onSessionEvicted: (pubkey) => {
          evictedKeys.push(pubkey);
        },
      });

      store.getOrCreateSession('client-1', false);
      store.getOrCreateSession('client-2', false);
      store.getOrCreateSession('client-3', false);

      // No eviction should occur
      expect(evictedKeys.length).toBe(0);
      expect(store.getSession('client-1')).toBeDefined();
      expect(store.getSession('client-2')).toBeDefined();
      expect(store.getSession('client-3')).toBeDefined();
      expect(store.sessionCount).toBe(3); // Capacity exceeded
    });

    it('should allow conditional eviction based on session state', () => {
      const evictedSessions: string[] = [];
      const store = new SessionStore({
        maxSessions: 2,
        shouldEvictSession: (_pubkey, session) => !session.isInitialized,
        onSessionEvicted: (pubkey) => {
          evictedSessions.push(pubkey);
        },
      });

      store.getOrCreateSession('client-1', false);
      store.getOrCreateSession('client-2', false);
      store.getOrCreateSession('client-3', false);

      // client-1 (uninitialized) should be evicted first
      expect(evictedSessions).toContain('client-1');
      expect(store.getSession('client-1')).toBeUndefined();
      expect(store.getSession('client-2')).toBeDefined();
      expect(store.getSession('client-3')).toBeDefined();

      // Mark client-2 as initialized
      store.markInitialized('client-2');

      // Add more sessions - client-3 (uninitialized) should be evicted next
      store.getOrCreateSession('client-4', false);
      store.getOrCreateSession('client-5', false);

      expect(evictedSessions).toContain('client-3');
      // client-2 (initialized) should be protected
      expect(store.getSession('client-2')).toBeDefined();
    });

    it('should protect sessions from eviction when shouldEvictSession returns false', () => {
      const evictedSessions: string[] = [];
      const store = new SessionStore({
        maxSessions: 2,
        shouldEvictSession: () => false,
        onSessionEvicted: (pubkey) => {
          evictedSessions.push(pubkey);
        },
      });

      store.getOrCreateSession('client-1', false);
      store.getOrCreateSession('client-2', false);

      // This should prevent eviction - sessions remain protected
      store.getOrCreateSession('client-3', false);

      // No evictions should have occurred
      expect(evictedSessions.length).toBe(0);
      expect(store.getSession('client-1')).toBeDefined();
      expect(store.getSession('client-2')).toBeDefined();
      expect(store.getSession('client-3')).toBeDefined();

      // Access client-1 to make it most recently used
      store.getSession('client-1');

      // Add another session - eviction still prevented
      store.getOrCreateSession('client-4', false);

      // No evictions
      expect(evictedSessions.length).toBe(0);
      expect(store.getSession('client-1')).toBeDefined();
      expect(store.getSession('client-2')).toBeDefined();
      expect(store.getSession('client-3')).toBeDefined();
      expect(store.getSession('client-4')).toBeDefined();
    });
  });

  describe('basic operations', () => {
    it('should create and retrieve sessions', () => {
      const store = new SessionStore({ maxSessions: 10 });

      const session = store.getOrCreateSession('client-1', true);

      expect(session.isEncrypted).toBe(true);
      expect(session.isInitialized).toBe(false);
      expect(store.getSession('client-1')).toBe(session);
    });

    it('should update activity timestamp', async () => {
      const store = new SessionStore({ maxSessions: 10 });
      const session = store.getOrCreateSession('client-1', false);

      const before = session.lastActivity;

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = store.updateActivity('client-1');

      expect(updated).toBe(true);
      expect(store.getSession('client-1')!.lastActivity).toBeGreaterThanOrEqual(
        before,
      );
    });

    it('should mark sessions as initialized', () => {
      const store = new SessionStore({ maxSessions: 10 });

      store.getOrCreateSession('client-1', false);
      const result = store.markInitialized('client-1');

      expect(result).toBe(true);
      expect(store.getSession('client-1')!.isInitialized).toBe(true);
    });

    it('should return false when updating activity for non-existent session', () => {
      const store = new SessionStore({ maxSessions: 10 });

      const result = store.updateActivity('non-existent');

      expect(result).toBe(false);
    });

    it('should remove sessions', () => {
      const store = new SessionStore({ maxSessions: 10 });

      store.getOrCreateSession('client-1', false);
      const result = store.removeSession('client-1');

      expect(result).toBe(true);
      expect(store.getSession('client-1')).toBeUndefined();
    });

    it('should clear all sessions', () => {
      const store = new SessionStore({ maxSessions: 10 });

      store.getOrCreateSession('client-1', false);
      store.getOrCreateSession('client-2', true);

      store.clear();

      expect(store.sessionCount).toBe(0);
      expect(store.getSession('client-1')).toBeUndefined();
      expect(store.getSession('client-2')).toBeUndefined();
    });

    it('should iterate over all sessions', () => {
      const store = new SessionStore({ maxSessions: 10 });

      store.getOrCreateSession('client-1', false);
      store.getOrCreateSession('client-2', true);

      const sessions = Array.from(store.getAllSessions());

      expect(sessions.length).toBe(2);
      expect(sessions.map(([key]) => key)).toContain('client-1');
      expect(sessions.map(([key]) => key)).toContain('client-2');
    });
  });
});
