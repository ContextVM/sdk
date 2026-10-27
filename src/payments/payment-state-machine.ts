import { canonicalJson } from '../core/utils/canonical-json.js';
import type {
  PaymentStateAdmission,
  PaymentStateAdmissionResult,
  PaymentStatePolicy,
  PaymentStateRecord,
  PaymentStateTransition,
} from './payment-state-store.js';
import {
  paymentAuthorizationKey,
  paymentEventKey,
} from './payment-state-store.js';
import { paymentOptionSchema } from './payment-option-schema.js';

/** Atomic backend view; implementations hold their lock while applying changes. */
export interface PaymentStateView {
  record?: PaymentStateRecord;
  execution?: PaymentStateRecord;
  total: number;
  pending: number;
}

/** Storage changes produced without external payment or application I/O. */
export interface PaymentStateChange<T> {
  result: T;
  put: PaymentStateRecord[];
  remove: string[];
}

/** Whether a record currently occupies a pending-payment slot. */
export function isLivePaymentLease(
  record: PaymentStateRecord,
  now: number,
): boolean {
  return (
    ['reserved', 'issuing', 'pending'].includes(record.phase) &&
    record.leaseExpiresAtMs > now
  );
}

/** Tombstones are collected only after their events become inadmissible. */
export function canCollectPaymentRecord(
  record: PaymentStateRecord,
  now: number,
): boolean {
  return (
    record.retainUntilMs !== null &&
    record.retainUntilMs <= now &&
    !isLivePaymentLease(record, now) &&
    !(
      (record.invoice && !record.settlement) ||
      (record.invoice &&
        ['consumed', 'dispatched'].includes(record.phase) &&
        record.delivery?.status !== 'published')
    )
  );
}

/** Applies atomic admission/claim under the backend's namespace lock. */
export function admitPaymentState(
  input: PaymentStateAdmission,
  view: PaymentStateView,
  policy: PaymentStatePolicy,
  now: number,
  generation: string,
): PaymentStateChange<PaymentStateAdmissionResult> {
  const done = (
    status: Exclude<
      PaymentStateAdmissionResult['status'],
      'reserved' | 'claimed'
    >,
    record = view.record,
  ): PaymentStateChange<PaymentStateAdmissionResult> => ({
    result: { status, ...(record && { record: structuredClone(record) }) },
    put: [],
    remove: [],
  });
  if (
    !Number.isFinite(input.leaseMs) ||
    input.leaseMs < 1 ||
    input.leaseMs > 2_147_483_647 ||
    !input.key ||
    !input.clientPubkey ||
    !input.requestEventId ||
    !input.invocationHash
  ) {
    throw new TypeError('Invalid payment admission');
  }
  const expectedKey =
    input.mode === 'transparent'
      ? paymentEventKey(input.clientPubkey, input.requestEventId)
      : paymentAuthorizationKey(input.clientPubkey, input.invocationHash);
  if (
    !['transparent', 'explicit_gating'].includes(input.mode) ||
    input.key !== expectedKey
  )
    throw new TypeError('Payment key does not match its identity');
  const event = input.event;
  if (
    event &&
    (event.id !== input.requestEventId ||
      event.author !== input.clientPubkey ||
      !Number.isSafeInteger(event.createdAt) ||
      event.createdAt < 0 ||
      event.createdAt * 1000 <= now - policy.replayWindowMs ||
      event.createdAt * 1000 > now + policy.maxFutureSkewMs)
  )
    return done('stale');
  if (view.execution) return done('duplicate', view.execution);
  const eventDeadline = event
    ? event.createdAt * 1000 + policy.replayWindowMs
    : null;
  const current = view.record;
  if (current) {
    if (
      current.clientPubkey !== input.clientPubkey ||
      current.invocationHash !== input.invocationHash
    )
      return done('unknown');
    if (input.mode === 'transparent') return done('duplicate');
    if (
      current.invoice &&
      ['pending', 'expired'].includes(current.phase) &&
      current.leaseExpiresAtMs <= now
    )
      return done('unknown');
    if (
      current.phase === 'unknown' ||
      (current.phase === 'issuing' && current.leaseExpiresAtMs <= now)
    )
      return done('unknown');
    if (current.phase === 'granted') {
      if ((current.grantExpiresAtMs ?? 0) <= now) return done('expired');
      const eventIds = [
        ...new Set([...current.eventIds, input.requestEventId]),
      ];
      const replayExpiresAtMs =
        current.replayExpiresAtMs === null || eventDeadline === null
          ? null
          : Math.max(current.replayExpiresAtMs, eventDeadline);
      const consumed: PaymentStateRecord = {
        ...current,
        phase: 'consumed',
        eventIds,
        replayExpiresAtMs,
        retainUntilMs: null,
      };
      const execution: PaymentStateRecord = {
        ...consumed,
        key: paymentEventKey(input.clientPubkey, input.requestEventId),
        requestEventId: input.requestEventId,
      };
      // Move the paid right into its execution tombstone in the same transaction;
      // claiming must not require extra capacity after money has been accepted.
      return {
        result: { status: 'claimed', record: structuredClone(execution) },
        put: [execution],
        remove: [current.key],
      };
    }
    if (isLivePaymentLease(current, now)) {
      if (current.eventIds.includes(input.requestEventId))
        return done('pending');
      if (current.eventIds.length >= policy.maxEventsPerPayment - 1)
        return done('capacity');
      const updated = {
        ...current,
        eventIds: [...current.eventIds, input.requestEventId],
        replayExpiresAtMs:
          current.replayExpiresAtMs === null || eventDeadline === null
            ? null
            : Math.max(current.replayExpiresAtMs, eventDeadline),
      };
      if (updated.retainUntilMs !== null && updated.replayExpiresAtMs !== null)
        updated.retainUntilMs = Math.max(
          updated.retainUntilMs,
          updated.replayExpiresAtMs,
        );
      return {
        result: { status: 'pending', record: structuredClone(updated) },
        put: [updated],
        remove: [],
      };
    }
    if (event && current.eventIds.includes(input.requestEventId))
      return done('duplicate');
    if (
      current.requestEventId === input.requestEventId &&
      ['consumed', 'dispatched', 'rejected'].includes(current.phase)
    )
      return done('duplicate');
  }
  const archive = current?.invoice
    ? {
        ...current,
        key: JSON.stringify(['attempt', current.generation]),
        phase: 'expired' as const,
        retainUntilMs: current.retainUntilMs,
      }
    : undefined;
  const additional = current ? (archive ? 1 : 0) : 1;
  if (
    view.pending >= policy.maxPendingPayments ||
    view.total + additional > policy.maxPaymentRecords
  )
    return done('capacity');
  const record: PaymentStateRecord = {
    key: input.key,
    generation,
    mode: input.mode,
    phase: 'reserved',
    clientPubkey: input.clientPubkey,
    requestEventId: input.requestEventId,
    eventIds: [input.requestEventId],
    replayExpiresAtMs: eventDeadline,
    invocationHash: input.invocationHash,
    leaseExpiresAtMs: now + Math.floor(input.leaseMs),
    retainUntilMs:
      event && input.mode === 'transparent'
        ? event.createdAt * 1000 + policy.replayWindowMs
        : input.mode === 'transparent'
          ? null
          : Math.max(now + policy.replayWindowMs, eventDeadline ?? 0),
  };
  return {
    result: { status: 'reserved', record: structuredClone(record) },
    put: [...(archive ? [archive] : []), record],
    remove: [],
  };
}

/** Applies a fenced state transition; expired/superseded workers cannot commit. */
export function transitionPaymentState(
  input: PaymentStateTransition,
  current: PaymentStateRecord | undefined,
  now: number,
  _policy: PaymentStatePolicy,
): PaymentStateChange<boolean> {
  const none: PaymentStateChange<boolean> = {
    result: false,
    put: [],
    remove: [],
  };
  if (!current || current.generation !== input.generation) return none;
  const record = structuredClone(current);
  const live = isLivePaymentLease(record, now);
  switch (input.type) {
    case 'issuing':
      if (record.phase !== 'reserved' || !live) return none;
      record.phase = 'issuing';
      record.retainUntilMs = null;
      break;
    case 'bind':
      if (record.phase !== 'issuing') return none;
      if (
        !Number.isFinite(input.leaseMs) ||
        input.leaseMs < 1 ||
        input.leaseMs > 2_147_483_647
      )
        throw new TypeError('Invalid payment lease');
      record.invoice = paymentOptionSchema.parse(input.invoice);
      JSON.stringify(record.invoice, (_key, value: unknown) => {
        if (
          typeof value === 'function' ||
          typeof value === 'symbol' ||
          typeof value === 'bigint' ||
          (typeof value === 'number' && !Number.isFinite(value))
        )
          throw new TypeError('Invoice must be JSON serializable');
        return value;
      });
      record.invoice = JSON.parse(
        JSON.stringify(record.invoice),
      ) as NonNullable<PaymentStateRecord['invoice']>;
      record.invoiceExpiresAtMs = Math.min(
        Number.MAX_SAFE_INTEGER,
        now +
          Math.floor(
            record.invoice.ttl === undefined
              ? input.leaseMs
              : record.invoice.ttl * 1000,
          ),
      );
      if (!live) {
        record.phase = 'unknown';
        record.retainUntilMs = null;
        return { ...none, put: [record] };
      }
      record.phase = 'pending';
      record.leaseExpiresAtMs = Math.min(
        record.leaseExpiresAtMs,
        now + Math.floor(input.leaseMs),
        record.invoiceExpiresAtMs,
      );
      record.retainUntilMs = null;
      break;
    case 'grant':
      if (
        record.phase !== 'pending' ||
        !live ||
        record.mode !== 'explicit_gating'
      )
        return none;
      if (
        !Number.isFinite(input.ttlMs) ||
        input.ttlMs < 1 ||
        input.ttlMs > 2_147_483_647
      )
        throw new TypeError('Invalid authorization TTL');
      record.phase = 'granted';
      record.settlement = { verifiedAtMs: now };
      record.grantExpiresAtMs = now + Math.floor(input.ttlMs);
      record.retainUntilMs = null;
      break;
    case 'consume':
      if (!['pending', 'reserved'].includes(record.phase) || !live) return none;
      record.phase = 'consumed';
      record.retainUntilMs = record.invoice ? null : record.replayExpiresAtMs;
      if (record.mode === 'explicit_gating') {
        record.key = paymentEventKey(
          record.clientPubkey,
          record.requestEventId,
        );
        record.retainUntilMs = record.invoice ? null : record.replayExpiresAtMs;
        return { result: true, put: [record], remove: [current.key] };
      }
      break;
    case 'dispatch':
      if (record.phase !== 'consumed') return none;
      record.phase = 'dispatched';
      break;
    case 'offer_published':
      if (
        !record.invoice ||
        !['pending', 'unknown', 'expired'].includes(record.phase)
      )
        return none;
      record.offerStatus = 'published';
      break;
    case 'reconciliation_claim':
      if (
        !record.invoice ||
        record.settlement ||
        !['pending', 'expired', 'unknown'].includes(record.phase) ||
        (record.reconciliation && record.reconciliation.leaseExpiresAtMs > now)
      )
        return none;
      if (
        !input.owner ||
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 1 ||
        input.leaseMs > 2_147_483_647
      )
        throw new TypeError('Invalid reconciliation lease');
      record.reconciliation = {
        owner: input.owner,
        leaseExpiresAtMs: now + input.leaseMs,
      };
      record.retainUntilMs = null;
      break;
    case 'reconciliation_release':
      if (record.reconciliation?.owner !== input.owner) return none;
      delete record.reconciliation;
      break;
    case 'settled':
      if (
        input.owner &&
        (record.reconciliation?.owner !== input.owner ||
          record.reconciliation.leaseExpiresAtMs <= now)
      )
        return none;
      if (
        !record.invoice ||
        !['pending', 'expired', 'unknown'].includes(record.phase)
      )
        return none;
      if (
        !Number.isSafeInteger(input.ttlMs) ||
        input.ttlMs < 1 ||
        input.ttlMs > 2_147_483_647
      )
        throw new TypeError('Invalid recovery authorization TTL');
      record.settlement = { verifiedAtMs: now };
      delete record.reconciliation;
      record.retainUntilMs = null;
      if (record.mode === 'explicit_gating') {
        record.phase = 'granted';
        record.grantExpiresAtMs = now + input.ttlMs;
      } else {
        // A reconciler recognizes money but never executes an application handler.
        record.phase = 'pending';
        record.leaseExpiresAtMs = now + input.ttlMs;
      }
      break;
    case 'result':
      if (!['consumed', 'dispatched'].includes(record.phase)) return none;
      if (record.delivery)
        return canonicalJson(record.delivery.response) ===
          canonicalJson(input.delivery.response)
          ? { result: true, put: [], remove: [] }
          : none;
      record.delivery = JSON.parse(
        JSON.stringify(input.delivery),
      ) as typeof input.delivery;
      record.retainUntilMs = null;
      break;
    case 'publication_claim':
      if (
        !record.delivery ||
        record.delivery.status === 'published' ||
        (record.delivery.owner && (record.delivery.leaseExpiresAtMs ?? 0) > now)
      )
        return none;
      if (
        !input.owner ||
        !Number.isSafeInteger(input.leaseMs) ||
        input.leaseMs < 1 ||
        input.leaseMs > 2_147_483_647
      )
        throw new TypeError('Invalid publication lease');
      record.delivery.owner = input.owner;
      record.delivery.leaseExpiresAtMs = now + input.leaseMs;
      break;
    case 'publication_progress':
      if (
        !record.delivery ||
        record.delivery.owner !== input.owner ||
        (record.delivery.leaseExpiresAtMs ?? 0) <= now ||
        record.delivery.status === 'published'
      )
        return none;
      if (
        !Number.isSafeInteger(input.frames) ||
        input.frames < record.delivery.acknowledgedFrames ||
        (input.chunkSizeBytes !== undefined &&
          (!Number.isSafeInteger(input.chunkSizeBytes) ||
            input.chunkSizeBytes < 1))
      )
        throw new TypeError('Invalid publication progress');
      if (
        record.delivery.chunkSizeBytes !== undefined &&
        input.chunkSizeBytes !== record.delivery.chunkSizeBytes
      )
        return none;
      if (input.leaseMs !== undefined) {
        if (
          !Number.isSafeInteger(input.leaseMs) ||
          input.leaseMs < 1 ||
          input.leaseMs > 2_147_483_647
        )
          throw new TypeError('Invalid publication renewal');
        record.delivery.leaseExpiresAtMs = now + input.leaseMs;
      }
      record.delivery.acknowledgedFrames = input.frames;
      if (input.chunkSizeBytes !== undefined)
        record.delivery.chunkSizeBytes = input.chunkSizeBytes;
      break;
    case 'published':
    case 'publication_failed':
      if (
        !record.delivery ||
        record.delivery.owner !== input.owner ||
        record.delivery.status === 'published'
      )
        return none;
      record.delivery.status =
        input.type === 'published' ? 'published' : 'unknown';
      delete record.delivery.owner;
      delete record.delivery.leaseExpiresAtMs;
      record.retainUntilMs =
        input.type === 'published' ? record.replayExpiresAtMs : null;
      break;
    case 'release':
      if (record.phase !== 'reserved') return none;
      return { result: true, put: [], remove: [record.key] };
    case 'reject':
      if (record.phase !== 'reserved' || !live) return none;
      record.phase = 'rejected';
      break;
    case 'expire':
      if (record.phase !== 'pending') return none;
      record.phase = 'expired';
      record.leaseExpiresAtMs = now;
      break;
    case 'uncertain':
      if (!['issuing', 'pending'].includes(record.phase)) return none;
      record.phase = 'unknown';
      record.reason = input.reason;
      record.retainUntilMs = null;
      break;
    default:
      throw new TypeError('Unknown payment state transition');
  }
  return { result: true, put: [record], remove: [] };
}
