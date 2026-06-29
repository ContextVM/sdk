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

    test('excludes params._meta from the identity (progressToken/stream do not affect hash)', () => {
      // `_meta` is MCP's reserved per-request extension namespace (progressToken,
      // stream, related-task metadata, ...) and MUST NOT affect the canonical
      // identity — the MCP client SDK regenerates progressToken on every call.
      const noMeta = computeCanonicalInvocationHash('tools/call', {
        name: 'add',
        arguments: { a: 1, b: 2 },
      });
      const metaProgress1 = computeCanonicalInvocationHash('tools/call', {
        name: 'add',
        arguments: { a: 1, b: 2 },
        _meta: { progressToken: 1 },
      });
      const metaProgress999 = computeCanonicalInvocationHash('tools/call', {
        name: 'add',
        arguments: { a: 1, b: 2 },
        _meta: { progressToken: 999, stream: 'writer' },
      });

      expect(noMeta).toBe(metaProgress1);
      expect(noMeta).toBe(metaProgress999);

      // Semantic params still differentiate identities.
      const differentArgs = computeCanonicalInvocationHash('tools/call', {
        name: 'add',
        arguments: { a: 2, b: 2 },
        _meta: { progressToken: 1 },
      });
      expect(noMeta).not.toBe(differentArgs);
    });

    test('passes array and primitive params through unchanged (no _meta slot)', () => {
      // JSON-RPC permits positional (array) and primitive params; only the
      // object form has a reserved _meta, so these hash as-is.
      expect(computeCanonicalInvocationHash('tools/call', [1, 2, 3])).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(computeCanonicalInvocationHash('tools/call', 'literal')).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });

    test('throws error for circular references', () => {
      const obj: Record<string, unknown> = {};
      obj.self = obj;
      expect(() => computeCanonicalInvocationHash('tools/call', obj)).toThrow(
        "Failed to canonicalize invocation payload for method 'tools/call'. Ensure params contain only JSON-serializable values (no circular references, functions, symbols, or BigInt).",
      );
    });

    test('throws error for non-serializable values', () => {
      expect(() =>
        computeCanonicalInvocationHash('tools/call', { fn: () => {} }),
      ).toThrow(
        "Failed to canonicalize invocation payload for method 'tools/call'. Ensure params contain only JSON-serializable values (no circular references, functions, symbols, or BigInt).",
      );
      expect(() =>
        computeCanonicalInvocationHash('tools/call', { sym: Symbol('test') }),
      ).toThrow(
        "Failed to canonicalize invocation payload for method 'tools/call'. Ensure params contain only JSON-serializable values (no circular references, functions, symbols, or BigInt).",
      );
      expect(() =>
        computeCanonicalInvocationHash('tools/call', {
          big: BigInt('9007199254740991'),
        }),
      ).toThrow(
        "Failed to canonicalize invocation payload for method 'tools/call'. Ensure params contain only JSON-serializable values (no circular references, functions, symbols, or BigInt).",
      );
    });

    test('handles empty string method', () => {
      const hash1 = computeCanonicalInvocationHash('', { a: 1 });
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('computeCanonicalInvocationIdentity', () => {
    test('combines pubkey and hash correctly', () => {
      const pubkey = 'test-client-pubkey';
      const method = 'tools/call';
      const params = { name: 'test' };

      const identity = computeCanonicalInvocationIdentity(
        pubkey,
        method,
        params,
      );

      expect(identity.clientPubkey).toBe(pubkey);
      expect(identity.invocationHash).toBe(
        computeCanonicalInvocationHash(method, params),
      );
    });
  });
});
