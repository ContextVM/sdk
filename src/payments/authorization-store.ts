import type { CanonicalInvocationIdentity } from './types.js';
import { LruCache } from '../core/utils/lru-cache.js';
import { createLogger } from '../core/utils/logger.js';

interface PaidAuthorization {
  /** Composite key: `${clientPubkey}:${invocationHash}` */
  key: string;
  expiresAtMs: number;
  /** Number of remaining executions (usually 1). */
  remaining: number;
}

/**
 * A bounded, TTL-aware store for explicit gating authorizations.
 * It manages both the pending state (waiting for payment verification)
 * and the granted state (paid and ready to consume).
 *
 * NOTE: The atomicity provided by `trySetPending` relies on in-memory maps,
 * meaning it is strictly single-process. For multi-process horizontal scaling,
 * implementers should use a distributed lock (e.g. Redis Redlock) keyed by
 * the canonical invocation identity to prevent duplicate payments.
 */
export class AuthorizationStore {
  private readonly authorizations: LruCache<PaidAuthorization>;
  private readonly pending: LruCache<number>; // Map of key -> expiresAtMs
  private readonly logger = createLogger('authorization-store');

  constructor(opts?: { maxEntries?: number }) {
    const maxEntries = opts?.maxEntries ?? 5000;
    this.authorizations = new LruCache<PaidAuthorization>(maxEntries);
    this.pending = new LruCache<number>(maxEntries);
  }

  private getKey(identity: CanonicalInvocationIdentity): string {
    return `${identity.clientPubkey}:${identity.invocationHash}`;
  }

  /**
   * Records a paid authorization.
   */
  public grant(
    identity: CanonicalInvocationIdentity,
    ttlMs: number,
    count: number = 1,
  ): void {
    if (count <= 0) {
      throw new RangeError('Authorization count must be greater than 0');
    }

    const key = this.getKey(identity);
    const expiresAtMs = Date.now() + ttlMs;

    this.authorizations.set(key, {
      key,
      expiresAtMs,
      remaining: count,
    });

    // Once granted, it's no longer pending
    this.pending.delete(key);

    this.logger.debug('authorization granted', {
      key,
      ttlMs,
      count,
    });
  }

  /**
   * Atomically claims one execution authorization.
   * Returns true if claimed, false if none available.
   */
  public claim(identity: CanonicalInvocationIdentity): boolean {
    const key = this.getKey(identity);
    const auth = this.authorizations.get(key);

    if (!auth) {
      return false;
    }

    if (Date.now() > auth.expiresAtMs) {
      this.authorizations.delete(key);
      return false;
    }

    if (auth.remaining > 0) {
      auth.remaining -= 1;
      if (auth.remaining === 0) {
        this.authorizations.delete(key);
      } else {
        // Explicitly delete and set to guarantee LRU position is refreshed
        this.authorizations.delete(key);
        this.authorizations.set(key, auth);
      }
      this.logger.debug('authorization claimed', {
        key,
        remaining: auth.remaining,
      });
      return true;
    }

    return false;
  }

  /**
   * Atomically checks whether a payment is already pending for this identity
   * and, if not, marks it as pending. Returns `true` if this call transitioned
   * the identity to pending (caller should emit -32042). Returns `false` if
   * already pending (caller should emit -32043).
   *
   * This atomic check-and-set prevents concurrent requests from both receiving
   * -32042 and triggering duplicate payment flows.
   * NOTE: This is single-process only. Distributed setups must use an external lock.
   */
  public trySetPending(
    identity: CanonicalInvocationIdentity,
    ttlMs: number,
  ): boolean {
    const key = this.getKey(identity);
    const now = Date.now();

    const existingExpiry = this.pending.get(key);
    if (existingExpiry !== undefined) {
      if (now > existingExpiry) {
        // Expired pending state, we can overwrite it
        this.pending.delete(key);
      } else {
        // Already pending and active
        return false;
      }
    }

    this.pending.set(key, now + ttlMs);
    this.logger.debug('authorization marked pending', { key, ttlMs });
    return true;
  }

  /** Checks if a payment is pending (not yet authorized). */
  public hasPending(identity: CanonicalInvocationIdentity): boolean {
    const key = this.getKey(identity);
    const expiry = this.pending.get(key);

    if (expiry === undefined) {
      return false;
    }

    if (Date.now() > expiry) {
      this.pending.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Updates the TTL of an already pending authorization. No-op if not pending.
   *
   * @param identity The canonical invocation identity.
   * @param ttlMs The new TTL in milliseconds to apply from now.
   * @returns void
   */
  public updatePendingTtl(
    identity: CanonicalInvocationIdentity,
    ttlMs: number,
  ): void {
    const key = this.getKey(identity);
    const existingExpiry = this.pending.get(key);
    if (existingExpiry !== undefined && Date.now() <= existingExpiry) {
      this.pending.set(key, Date.now() + ttlMs);
      this.logger.debug('authorization pending TTL updated', { key, ttlMs });
    }
  }

  /** Gets the remaining TTL in milliseconds for a pending authorization, or 0 if not pending. */
  public getPendingRemainingMs(identity: CanonicalInvocationIdentity): number {
    const key = this.getKey(identity);
    const expiry = this.pending.get(key);
    if (expiry === undefined) return 0;
    const remaining = expiry - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /** Clears pending state (e.g. on verification failure or expiry). */
  public clearPending(identity: CanonicalInvocationIdentity): void {
    const key = this.getKey(identity);
    this.pending.delete(key);
    this.logger.debug('authorization pending state cleared', { key });
  }
}
