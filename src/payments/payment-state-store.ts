import type { PaymentResultDelivery } from './payment-delivery.js';
import type { PaymentInteractionMode, PaymentOption } from './types.js';

/** Immutable identity captured from a verified, unwrapped Nostr event. */
export interface VerifiedPaymentEvent {
  readonly id: string;
  readonly author: string;
  /** Nostr creation time in seconds. */
  readonly createdAt: number;
}

/** Bounded storage and replay-admission policy shared by every worker. */
export interface PaymentStatePolicy {
  /** Maximum live invoice/verification leases across both payment modes. */
  readonly maxPendingPayments: number;
  /** Maximum retained records, including replay tombstones and old attempts. */
  readonly maxPaymentRecords: number;
  /** Events this old are rejected before admission; default 24 hours. */
  readonly replayWindowMs: number;
  /** Maximum accepted future timestamp skew; default 60 seconds. */
  readonly maxFutureSkewMs: number;
  /** Bounded event IDs retained per attempt, including its eventual consumer. */
  readonly maxEventsPerPayment: number;
}

/** Persisted stages. Dispatched means transport handoff, not handler completion or client receipt. */
export type PaymentStatePhase =
  | 'reserved'
  | 'issuing'
  | 'pending'
  | 'granted'
  | 'consumed'
  | 'dispatched'
  | 'expired'
  | 'unknown'
  | 'rejected';

/** Recovery record. Invoice data can be sensitive; never log this object. */
export interface PaymentStateRecord {
  key: string;
  generation: string;
  mode: PaymentInteractionMode;
  phase: PaymentStatePhase;
  clientPubkey: string;
  requestEventId: string;
  eventIds: string[];
  /** Last admission deadline of the attempt's events; null for untimed transports. */
  replayExpiresAtMs: number | null;
  invocationHash: string;
  leaseExpiresAtMs: number;
  /** Null means retain until explicit recovery; never evict a paid grant. */
  retainUntilMs: number | null;
  invoice?: PaymentOption;
  /** Known invoice expiry, retained independently of the worker's verification lease. */
  invoiceExpiresAtMs?: number;
  grantExpiresAtMs?: number;
  reason?: string;
  reconciliation?: { owner: string; leaseExpiresAtMs: number };
  offerStatus?: 'published' | 'unknown';
  settlement?: { verifiedAtMs: number };
  delivery?: PaymentResultDelivery;
}

/** Atomic claim-or-reserve request. Callers never compose a read and write. */
export interface PaymentStateAdmission {
  key: string;
  mode: PaymentInteractionMode;
  clientPubkey: string;
  requestEventId: string;
  invocationHash: string;
  leaseMs: number;
  event?: VerifiedPaymentEvent;
}

/** Result of one atomic admission, including capacity and recovery outcomes. */
export type PaymentStateAdmissionResult =
  | { status: 'reserved' | 'claimed'; record: PaymentStateRecord }
  | {
      status:
        'pending' | 'duplicate' | 'capacity' | 'stale' | 'unknown' | 'expired';
      record?: PaymentStateRecord;
    };

/** Generation-fenced change; false means the worker must stop side effects. */
export type PaymentStateTransition = {
  key: string;
  generation: string;
} & (
  | {
      type:
        | 'issuing'
        | 'consume'
        | 'dispatch'
        | 'release'
        | 'reject'
        | 'expire'
        | 'offer_published';
    }
  | { type: 'bind'; invoice: PaymentOption; leaseMs: number }
  | { type: 'grant'; ttlMs: number }
  | { type: 'uncertain'; reason: string }
  | { type: 'settled'; ttlMs: number; owner?: string }
  | { type: 'reconciliation_claim'; owner: string; leaseMs: number }
  | { type: 'reconciliation_release'; owner: string }
  | { type: 'result'; delivery: PaymentResultDelivery }
  | { type: 'publication_claim'; owner: string; leaseMs: number }
  | {
      type: 'publication_progress';
      leaseMs?: number;
      owner: string;
      frames: number;
      chunkSizeBytes?: number;
    }
  | { type: 'published' | 'publication_failed'; owner: string }
);

/**
 * Atomic payment storage contract. Backend errors propagate, including uncertain
 * commit acknowledgement; callers must not retry external effects or fall back
 * to a fresh memory store. A consumed execution right is never auto-restored.
 * Applications may inject their own implementation through `stateStore` and
 * own its dependencies and lifecycle. Only the in-memory implementation is bundled.
 */
export interface PaymentStateStore {
  readonly policy: PaymentStatePolicy;
  admit(input: PaymentStateAdmission): Promise<PaymentStateAdmissionResult>;
  transition(input: PaymentStateTransition): Promise<boolean>;
  read(key: string): Promise<PaymentStateRecord | undefined>;
}

/** Collision-free, peer-scoped transparent replay key. */
export function paymentEventKey(clientPubkey: string, eventId: string): string {
  return JSON.stringify(['event', clientPubkey, eventId]);
}

/** Collision-free canonical authorization key. */
export function paymentAuthorizationKey(
  clientPubkey: string,
  invocationHash: string,
): string {
  return JSON.stringify(['authorization', clientPubkey, invocationHash]);
}

/** Validates and freezes policy before any store or transport mutation. */
export function createPaymentStatePolicy(
  options: Partial<PaymentStatePolicy> = {},
): PaymentStatePolicy {
  const policy = {
    maxPendingPayments: options.maxPendingPayments ?? 1000,
    maxPaymentRecords: options.maxPaymentRecords ?? 10000,
    replayWindowMs: options.replayWindowMs ?? 86_400_000,
    maxFutureSkewMs: options.maxFutureSkewMs ?? 60_000,
    maxEventsPerPayment: options.maxEventsPerPayment ?? 128,
  };
  for (const [name, value] of Object.entries(policy)) {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (name === 'replayWindowMs' && value === 0) ||
      (name === 'maxEventsPerPayment' && value < 2)
    ) {
      throw new TypeError(`Invalid payment state policy: ${name}`);
    }
  }
  return Object.freeze(policy);
}
