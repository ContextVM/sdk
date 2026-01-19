import { describe, it, expect } from 'bun:test';
import { ClientCorrelationStore } from './correlation-store.js';

describe('ClientCorrelationStore', () => {
  describe('registerRequest', () => {
    it('stores request with eventId', () => {
      const store = new ClientCorrelationStore();
      store.registerRequest('event123', {
        originalRequestId: 'req1',
        isInitialize: false,
      });
      expect(store.hasPendingRequest('event123')).toBe(true);
    });

    it('stores initialize request flag', () => {
      const store = new ClientCorrelationStore();
      store.registerRequest('event456', {
        originalRequestId: 'req2',
        isInitialize: true,
      });
      const response = { jsonrpc: '2.0' as const, id: 'wrong', result: {} };
      store.resolveResponse('event456', response);
      expect(response.id).toBe('req2');
    });
  });

  describe('resolveResponse', () => {
    it('restores original request id', () => {
      const store = new ClientCorrelationStore();
      store.registerRequest('event789', {
        originalRequestId: 42,
        isInitialize: false,
      });
      const response = { jsonrpc: '2.0' as const, id: -1, result: {} };
      expect(store.resolveResponse('event789', response)).toBe(true);
      expect(response.id).toBe(42);
    });

    it('returns false for unknown eventId', () => {
      const store = new ClientCorrelationStore();
      const response = { jsonrpc: '2.0' as const, id: 1, result: {} };
      expect(store.resolveResponse('unknown', response)).toBe(false);
    });

    it('removes request after resolution', () => {
      const store = new ClientCorrelationStore();
      store.registerRequest('event1', {
        originalRequestId: null,
        isInitialize: false,
      });
      store.resolveResponse('event1', {
        jsonrpc: '2.0' as const,
        id: 1,
        result: {},
      });
      expect(store.hasPendingRequest('event1')).toBe(false);
    });
  });

  describe('removePendingRequest', () => {
    it('removes existing request', () => {
      const store = new ClientCorrelationStore();
      store.registerRequest('event1', {
        originalRequestId: null,
        isInitialize: false,
      });
      expect(store.removePendingRequest('event1')).toBe(true);
      expect(store.hasPendingRequest('event1')).toBe(false);
    });

    it('returns false for unknown request', () => {
      const store = new ClientCorrelationStore();
      expect(store.removePendingRequest('unknown')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all pending requests', () => {
      const store = new ClientCorrelationStore();
      store.registerRequest('event1', {
        originalRequestId: null,
        isInitialize: false,
      });
      store.registerRequest('event2', {
        originalRequestId: null,
        isInitialize: false,
      });
      store.clear();
      expect(store.pendingRequestCount).toBe(0);
    });
  });

  describe('eviction callback', () => {
    it('triggers onRequestEvicted when limit reached', () => {
      const evictedIds: string[] = [];
      const store = new ClientCorrelationStore({
        maxPendingRequests: 2,
        onRequestEvicted: (eventId) => {
          evictedIds.push(eventId);
        },
      });
      for (let i = 0; i < 5; i++) {
        store.registerRequest(`event${i}`, {
          originalRequestId: null,
          isInitialize: false,
        });
      }
      expect(store.pendingRequestCount).toBe(2);
      expect(evictedIds.length).toBe(3);
    });
  });
});
