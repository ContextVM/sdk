import canonicalizePackage from 'canonicalize';
type CanonicalizeFn = (input: unknown) => string | undefined;
const canonicalize = canonicalizePackage as unknown as CanonicalizeFn;
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CanonicalInvocationIdentity } from './types.js';

/**
 * Computes a deterministic SHA-256 hash of an invocation's method and parameters.
 * Uses RFC 8785 JSON Canonicalization Scheme (JCS) to ensure structurally
 * identical JSON objects produce the same hash regardless of key ordering.
 *
 * @param method - The JSON-RPC method (e.g. 'tools/call')
 * @param params - The JSON-RPC parameters
 * @returns A hex-encoded SHA-256 hash string
 */
export function computeCanonicalInvocationHash(
  method: string,
  params: unknown,
): string {
  const payload = { method, params };
  let canonicalString: string | undefined;
  try {
    // Pre-validate that all values are strictly JSON-serializable.
    // canonicalize() might ignore functions/symbols or throw stack overflows,
    // so we use JSON.stringify as a strict validator first.
    JSON.stringify(payload, (_key, value) => {
      if (
        typeof value === 'function' ||
        typeof value === 'symbol' ||
        typeof value === 'bigint'
      ) {
        throw new Error('Invalid type');
      }
      return value;
    });
    canonicalString = canonicalize(payload);
  } catch {
    canonicalString = undefined;
  }

  if (canonicalString === undefined) {
    throw new Error(
      `Failed to canonicalize invocation payload for method '${method}'. ` +
        'Ensure params contain only JSON-serializable values (no circular references, functions, symbols, or BigInt).',
    );
  }

  return bytesToHex(sha256(new TextEncoder().encode(canonicalString)));
}

/**
 * Computes the canonical invocation identity for explicit-gating authorization matching.
 *
 * @param clientPubkey - The client's public key
 * @param method - The JSON-RPC method
 * @param params - The JSON-RPC parameters
 * @returns The computed identity
 */
export function computeCanonicalInvocationIdentity(
  clientPubkey: string,
  method: string,
  params: unknown,
): CanonicalInvocationIdentity {
  return {
    clientPubkey,
    invocationHash: computeCanonicalInvocationHash(method, params),
  };
}
