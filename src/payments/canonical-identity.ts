import { canonicalize } from 'json-canonicalize';
import { createHash } from 'crypto';
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
  const canonicalString = canonicalize(payload);
  
  return createHash('sha256')
    .update(canonicalString)
    .digest('hex');
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
