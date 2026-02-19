import { describe, it, expect } from 'bun:test';
import { CorrelationStore } from './correlation-store.js';

describe('CorrelationStore', () => {
  describe('registerEventRoute', () => {
    it('registers a route with all fields', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');

      const route = store.getEventRoute('event1');
      expect(route).toBeDefined();
      expect(route!.clientPubkey).toBe('client1');
      expect(route!.originalRequestId).toBe('req1');
      expect(route!.progressToken).toBe('token1');
    });

    it('registers a route without progress token', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');

      const route = store.getEventRoute('event1');
      expect(route).toBeDefined();
      expect(route!.progressToken).toBeUndefined();
    });

    it('registers a route with numeric request id', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 42);

      const route = store.getEventRoute('event1');
      expect(route!.originalRequestId).toBe(42);
    });

    it('updates client index when registering routes', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client1', 'req2');

      expect(store.hasActiveRoutesForClient('client1')).toBe(true);
    });

    it('registers progress token mapping', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');

      expect(store.getEventIdByProgressToken('token1')).toBe('event1');
      expect(store.hasProgressToken('token1')).toBe(true);
    });
  });

  describe('getEventRoute', () => {
    it('returns undefined for unknown event id', () => {
      const store = new CorrelationStore();
      expect(store.getEventRoute('unknown')).toBeUndefined();
    });

    it('updates LRU order on access', () => {
      const evictedIds: string[] = [];
      const store = new CorrelationStore({
        maxEventRoutes: 2,
        onEventRouteEvicted: (eventId) => evictedIds.push(eventId),
      });

      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client1', 'req2');
      store.getEventRoute('event1'); // Access event1 to make it MRU
      store.registerEventRoute('event3', 'client1', 'req3'); // Should evict event2

      expect(evictedIds).toContain('event2');
      expect(evictedIds).not.toContain('event1');
    });
  });

  describe('popEventRoute', () => {
    it('returns and removes the route atomically', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');

      const route = store.popEventRoute('event1');
      expect(route).toBeDefined();
      expect(route!.clientPubkey).toBe('client1');
      expect(route!.originalRequestId).toBe('req1');
      expect(route!.progressToken).toBe('token1');

      // Route + token mapping should be gone.
      expect(store.hasEventRoute('event1')).toBe(false);
      expect(store.hasProgressToken('token1')).toBe(false);

      // Second pop is a no-op.
      expect(store.popEventRoute('event1')).toBeUndefined();
    });
  });

  describe('getEventIdByProgressToken', () => {
    it('returns undefined for unknown token', () => {
      const store = new CorrelationStore();
      expect(store.getEventIdByProgressToken('unknown')).toBeUndefined();
    });

    it('returns correct event id for token', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');
      store.registerEventRoute('event2', 'client2', 'req2', 'token2');

      expect(store.getEventIdByProgressToken('token1')).toBe('event1');
      expect(store.getEventIdByProgressToken('token2')).toBe('event2');
    });
  });

  describe('removeRoutesForClient', () => {
    it('removes all routes for a client', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client1', 'req2');
      store.registerEventRoute('event3', 'client2', 'req3');

      const removed = store.removeRoutesForClient('client1');

      expect(removed).toBe(2);
      expect(store.hasEventRoute('event1')).toBe(false);
      expect(store.hasEventRoute('event2')).toBe(false);
      expect(store.hasEventRoute('event3')).toBe(true);
    });

    it('returns 0 for unknown client', () => {
      const store = new CorrelationStore();
      expect(store.removeRoutesForClient('unknown')).toBe(0);
    });

    it('cleans up progress tokens for all removed routes', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');
      store.registerEventRoute('event2', 'client1', 'req2', 'token2');

      store.removeRoutesForClient('client1');

      expect(store.hasProgressToken('token1')).toBe(false);
      expect(store.hasProgressToken('token2')).toBe(false);
    });

    it('removes client from index after cleanup', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');

      store.removeRoutesForClient('client1');

      expect(store.hasActiveRoutesForClient('client1')).toBe(false);
    });
  });

  describe('hasEventRoute', () => {
    it('returns true for existing route', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      expect(store.hasEventRoute('event1')).toBe(true);
    });

    it('returns false for unknown route', () => {
      const store = new CorrelationStore();
      expect(store.hasEventRoute('unknown')).toBe(false);
    });
  });

  describe('hasProgressToken', () => {
    it('returns true for existing token', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');
      expect(store.hasProgressToken('token1')).toBe(true);
    });

    it('returns false for unknown token', () => {
      const store = new CorrelationStore();
      expect(store.hasProgressToken('unknown')).toBe(false);
    });
  });

  describe('hasActiveRoutesForClient', () => {
    it('returns true when client has routes', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      expect(store.hasActiveRoutesForClient('client1')).toBe(true);
    });

    it('returns false when client has no routes', () => {
      const store = new CorrelationStore();
      expect(store.hasActiveRoutesForClient('client1')).toBe(false);
    });

    it('returns false after all client routes removed', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      store.popEventRoute('event1');
      expect(store.hasActiveRoutesForClient('client1')).toBe(false);
    });
  });

  describe('eventRouteCount', () => {
    it('returns 0 for empty store', () => {
      const store = new CorrelationStore();
      expect(store.eventRouteCount).toBe(0);
    });

    it('returns correct count after registrations', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client1', 'req2');
      expect(store.eventRouteCount).toBe(2);
    });

    it('returns correct count after removals', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client1', 'req2');
      store.popEventRoute('event1');
      expect(store.eventRouteCount).toBe(1);
    });
  });

  describe('progressTokenCount', () => {
    it('returns 0 for empty store', () => {
      const store = new CorrelationStore();
      expect(store.progressTokenCount).toBe(0);
    });

    it('returns correct count after registrations with tokens', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');
      store.registerEventRoute('event2', 'client1', 'req2', 'token2');
      store.registerEventRoute('event3', 'client1', 'req3'); // No token
      expect(store.progressTokenCount).toBe(2);
    });

    it('returns correct count after route removals', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');
      store.registerEventRoute('event2', 'client1', 'req2', 'token2');
      store.popEventRoute('event1');
      expect(store.progressTokenCount).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest route when capacity reached', () => {
      const evictedIds: string[] = [];
      const store = new CorrelationStore({
        maxEventRoutes: 2,
        onEventRouteEvicted: (eventId) => evictedIds.push(eventId),
      });

      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client1', 'req2');
      store.registerEventRoute('event3', 'client1', 'req3');

      expect(evictedIds).toContain('event1');
      expect(store.eventRouteCount).toBe(2);
    });

    it('cleans up progress tokens on eviction', () => {
      const store = new CorrelationStore({
        maxEventRoutes: 1,
      });

      store.registerEventRoute('event1', 'client1', 'req1', 'token1');
      store.registerEventRoute('event2', 'client1', 'req2', 'token2');

      expect(store.hasProgressToken('token1')).toBe(false);
      expect(store.hasProgressToken('token2')).toBe(true);
    });

    it('cleans up client index on eviction', () => {
      const store = new CorrelationStore({
        maxEventRoutes: 1,
      });

      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client2', 'req2');

      // Client1's only route was evicted
      expect(store.hasActiveRoutesForClient('client1')).toBe(false);
      expect(store.hasActiveRoutesForClient('client2')).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all routes', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');
      store.registerEventRoute('event2', 'client2', 'req2');

      store.clear();

      expect(store.eventRouteCount).toBe(0);
      expect(store.hasEventRoute('event1')).toBe(false);
    });

    it('removes all progress tokens', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1', 'token1');

      store.clear();

      expect(store.progressTokenCount).toBe(0);
      expect(store.hasProgressToken('token1')).toBe(false);
    });

    it('cleans up client index', () => {
      const store = new CorrelationStore();
      store.registerEventRoute('event1', 'client1', 'req1');

      store.clear();

      expect(store.hasActiveRoutesForClient('client1')).toBe(false);
    });
  });

  describe('complex scenarios', () => {
    it('handles multiple clients with multiple routes', () => {
      const store = new CorrelationStore();

      // Client 1: 2 routes
      store.registerEventRoute('c1e1', 'client1', 'r1', 't1');
      store.registerEventRoute('c1e2', 'client1', 'r2', 't2');

      // Client 2: 1 route
      store.registerEventRoute('c2e1', 'client2', 'r3', 't3');

      expect(store.eventRouteCount).toBe(3);
      expect(store.progressTokenCount).toBe(3);
      expect(store.hasActiveRoutesForClient('client1')).toBe(true);
      expect(store.hasActiveRoutesForClient('client2')).toBe(true);

      // Remove one of client1's routes
      store.popEventRoute('c1e1');

      expect(store.hasActiveRoutesForClient('client1')).toBe(true);
      expect(store.hasProgressToken('t1')).toBe(false);
      expect(store.hasProgressToken('t2')).toBe(true);
    });

    it('handles route replacement with same progress token', () => {
      // Note: This tests edge case where same token might be reused
      // In practice, tokens should be unique per request
      const store = new CorrelationStore();

      store.registerEventRoute('event1', 'client1', 'req1', 'token1');
      expect(store.getEventIdByProgressToken('token1')).toBe('event1');

      // Register new route with same token (overwrites mapping)
      store.registerEventRoute('event2', 'client1', 'req2', 'token1');
      expect(store.getEventIdByProgressToken('token1')).toBe('event2');
    });

    it('maintains consistency through mixed operations', () => {
      const store = new CorrelationStore({ maxEventRoutes: 3 });

      // Add routes
      store.registerEventRoute('e1', 'c1', 'r1', 't1');
      store.registerEventRoute('e2', 'c1', 'r2', 't2');
      store.registerEventRoute('e3', 'c2', 'r3', 't3');

      // Remove one
      store.popEventRoute('e2');

      // Add more to trigger eviction
      store.registerEventRoute('e4', 'c2', 'r4', 't4');

      // Verify consistency
      expect(store.hasEventRoute('e1')).toBe(true);
      expect(store.hasEventRoute('e2')).toBe(false);
      expect(store.hasEventRoute('e3')).toBe(true);
      expect(store.hasEventRoute('e4')).toBe(true);

      expect(store.hasProgressToken('t1')).toBe(true);
      expect(store.hasProgressToken('t2')).toBe(false);
      expect(store.hasProgressToken('t3')).toBe(true);
      expect(store.hasProgressToken('t4')).toBe(true);

      expect(store.hasActiveRoutesForClient('c1')).toBe(true);
      expect(store.hasActiveRoutesForClient('c2')).toBe(true);
    });
  });
});
