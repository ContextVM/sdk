import { describe, it, expect } from 'bun:test';
import { SessionStore } from './session-store.js';

describe('SessionStore', () => {
  describe('basic operations', () => {
    it('should create and retrieve sessions', () => {
      const store = new SessionStore({ maxSessions: 10 });

      const [session, created] = store.getOrCreateSession('client-1', true);

      expect(created).toBe(true);
      expect(session.isEncrypted).toBe(true);
      expect(session.isInitialized).toBe(false);
      expect(store.getSession('client-1')).toBe(session);
    });

    it('should mark sessions as initialized', () => {
      const store = new SessionStore({ maxSessions: 10 });

      store.getOrCreateSession('client-1', false);
      const result = store.markInitialized('client-1');

      expect(result).toBe(true);
      expect(store.getSession('client-1')!.isInitialized).toBe(true);
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
