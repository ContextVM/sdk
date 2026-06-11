import { describe, expect, test } from 'bun:test';
import {
  computeCanonicalInvocationHash,
  computeCanonicalInvocationIdentity,
} from './canonical-identity.js';

describe('Canonical Invocation Identity', () => {
  describe('computeCanonicalInvocationHash', () => {
    test('is deterministic regardless of object key order', () => {
      const hash1 = computeCanonicalInvocationHash('tools/call', {
        a: 1,
        b: 2,
        name: 'test',
      });
      
      const hash2 = computeCanonicalInvocationHash('tools/call', {
        name: 'test',
        b: 2,
        a: 1,
      });

      expect(hash1).toBe(hash2);
      // Ensure we're getting a hex string
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    test('handles empty params', () => {
      const hash1 = computeCanonicalInvocationHash('tools/call', undefined);
      const hash2 = computeCanonicalInvocationHash('tools/call', null);
      
      expect(hash1).not.toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    test('handles nested objects deterministically', () => {
      const hash1 = computeCanonicalInvocationHash('tools/call', {
        nested: { z: 1, y: 2, x: 3 },
        arr: [1, 2, 3],
      });
      
      const hash2 = computeCanonicalInvocationHash('tools/call', {
        arr: [1, 2, 3],
        nested: { x: 3, z: 1, y: 2 },
      });

      expect(hash1).toBe(hash2);
    });

    test('handles unicode correctly', () => {
      const hash1 = computeCanonicalInvocationHash('tools/call', {
        text: 'Hello 🌍',
      });
      
      const hash2 = computeCanonicalInvocationHash('tools/call', {
        text: 'Hello 🌍',
      });

      expect(hash1).toBe(hash2);
    });

    test('differs for different methods', () => {
      const hash1 = computeCanonicalInvocationHash('tools/call', { a: 1 });
      const hash2 = computeCanonicalInvocationHash('prompts/get', { a: 1 });

      expect(hash1).not.toBe(hash2);
    });
    
    test('differs for different param values', () => {
      const hash1 = computeCanonicalInvocationHash('tools/call', { a: 1 });
      const hash2 = computeCanonicalInvocationHash('tools/call', { a: 2 });

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('computeCanonicalInvocationIdentity', () => {
    test('combines pubkey and hash correctly', () => {
      const pubkey = 'test-client-pubkey';
      const method = 'tools/call';
      const params = { name: 'test' };

      const identity = computeCanonicalInvocationIdentity(pubkey, method, params);

      expect(identity.clientPubkey).toBe(pubkey);
      expect(identity.invocationHash).toBe(computeCanonicalInvocationHash(method, params));
    });
  });
});
