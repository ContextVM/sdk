import type { CanonicalInvocationIdentity } from './types.js';
import { LruCache } from '../core/utils/lru-cache.js';
import { createLogger } from '../core/utils/logger.js';

interface PaidAuthorization {
  /** Composite key: `${clientPubkey}:${invocationHash}` */
  key: string;
  expiresAtMs: number;
}

/**
 * A bounded, TTL-aware store for explicit gating authorizations.
 * It manages both the pending state (waiting for payment verification)
 * and the granted state (paid and ready to consume).
 *
 * Capacity safety: at capacity, expired entries are purged first and live
 * pending entries are NEVER silently evicted — an evicted live pending entry
 * disarms the payment dedup and a retry would mint a second invoice
 * (CEP-8: MUST NOT charge twice). `trySetPending` refuses instead.
 * Verified grants cannot be refused (the money is already taken), so `grant()`
 * purges expired grants first and only then falls back to LRU eviction.
 *
 * NOTE: The atomicity provided by `trySetPending` relies on in-memory maps,
 * meaning it is strictly single-process. For multi-process horizontal scaling,
 * implementers should use a distributed lock (e.g. Redis Redlock) keyed by
 * the canonical invocation identity to prevent duplicate payments.
 *
 * NOTE: Atomic reserve-then-dispatch (`claim()` here, `trySetPending()` in the
 * gating middlewares) relies on JavaScript run-to-completion: there is no
 * interleaving point between the two calls. Porters to await-capable runtimes
 * must compose them into a single critical section.
 */
export class AuthorizationStore {
  private readonly authorizations: LruCache<PaidAuthorization>;
  private readonly pending: LruCache<number>; // Map of key -> expiresAtMs
  private readonly maxEntries: number;
  private readonly logger = createLogger('authorization-store');

  constructor(opts?: { maxEntries?: number }) {
    this.maxEntries = opts?.maxEntries ?? 5000;
    this.authorizations = new LruCache<PaidAuthorization>(this.maxEntries);
    this.pending = new LruCache<number>(this.maxEntries);
  }

  private getKey(identity: CanonicalInvocationIdentity): string {
    return `${identity.clientPubkey}:${identity.invocationHash}`;
  }

  /**
   * Records a paid authorization. Each grant authorizes exactly one future
   * execution (CEP-8: "each successful payment SHOULD authorize one future
   * execution unless server policy explicitly grants a different number").
   */
  public grant(identity: CanonicalInvocationIdentity, ttlMs: number): void {
    const key = this.getKey(identity);
    const expiresAtMs = Date.now() + ttlMs;

    // Purge expired grants before any capacity-driven eviction: an evicted
    // unconsumed grant is paid-but-unusable and the client would be charged
    // again on retry.
    if (this.authorizations.size >= this.maxEntries) {
      this.purgeExpiredAuthorizations();
    }

    this.authorizations.set(key, { key, expiresAtMs });

    // Once granted, it's no longer pending
    this.pending.delete(key);

    this.logger.debug('authorization granted', { key, ttlMs });
  }

  /**
   * Atomically claims the single execution authorization.
   * Returns true if claimed, false if none available or expired.
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

    // Single-use: consume the authorization atomically.
    this.authorizations.delete(key);
    this.logger.debug('authorization claimed', { key });
    return true;
  }

  /** Removes expired pending entries (capacity-pressure cleanup). */
  private purgeExpiredPending(): void {
    const now = Date.now();
    for (const [key, expiry] of this.pending.entries()) {
      if (expiry <= now) {
        this.pending.delete(key);
      }
    }
  }

  /** Removes expired grants (capacity-pressure cleanup). */
  private purgeExpiredAuthorizations(): void {
    const now = Date.now();
    for (const [key, auth] of this.authorizations.entries()) {
      if (auth.expiresAtMs <= now) {
        this.authorizations.delete(key);
      }
    }
  }

  /**
   * Whether the pending map can accept a new entry: purges expired entries
   * first, then reports capacity. Lets callers refuse BEFORE minting an
   * invoice instead of silently evicting a live payment's dedup entry.
   */
  public hasPendingCapacity(): boolean {
    if (this.pending.size >= this.maxEntries) {
      this.purgeExpiredPending();
    }
    return this.pending.size < this.maxEntries;
  }

  /**
   * Atomically checks whether a payment is already pending for this identity
   * and, if not, marks it as pending. Returns `true` if this call transitioned
   * the identity to pending (caller should emit -32042). Returns `false` if
   * already pending (caller should emit -32043) or the store is at capacity
   * with only live entries (caller should refuse — check
   * {@link hasPendingCapacity} first to distinguish).
   *
   * This atomic check-and-set prevents concurrent requests from both receiving
   * -32042 and triggering duplicate payment flows. Live entries are never
   * evicted to make room: an evicted pending entry disarms the dedup and a
   * retry would be charged twice.
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

    if (this.pending.size >= this.maxEntries) {
      this.purgeExpiredPending();
      if (this.pending.size >= this.maxEntries) {
        // Refuse rather than evict a live payment's dedup entry.
        this.logger.warn('pending authorization capacity reached, refusing', {
          key,
          maxEntries: this.maxEntries,
        });
        return false;
      }
    }

    this.pending.set(key, now + ttlMs);
    this.logger.debug('authorization marked pending', { key, ttlMs });
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
