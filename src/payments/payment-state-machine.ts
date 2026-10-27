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
    !isLivePaymentLease(record, now)
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
  if (view.execution) return done('duplicate');
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
        retainUntilMs:
          replayExpiresAtMs === null
            ? null
            : Math.max(replayExpiresAtMs, current.invoiceExpiresAtMs ?? 0),
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
  policy: PaymentStatePolicy,
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
      if (record.mode === 'explicit_gating') record.retainUntilMs = null;
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
        if (record.mode === 'explicit_gating') record.retainUntilMs = null;
        return { ...none, put: [record] };
      }
      record.phase = 'pending';
      record.leaseExpiresAtMs = Math.min(
        record.leaseExpiresAtMs,
        now + Math.floor(input.leaseMs),
        record.invoiceExpiresAtMs,
      );
      record.retainUntilMs =
        record.replayExpiresAtMs === null
          ? null
          : Math.max(
              record.replayExpiresAtMs,
              record.invoiceExpiresAtMs,
              record.mode === 'explicit_gating'
                ? now + policy.replayWindowMs
                : 0,
            );
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
      record.grantExpiresAtMs = now + Math.floor(input.ttlMs);
      record.retainUntilMs = null;
      break;
    case 'consume':
      if (!['pending', 'reserved'].includes(record.phase) || !live) return none;
      record.phase = 'consumed';
      if (record.mode === 'explicit_gating') {
        record.key = paymentEventKey(
          record.clientPubkey,
          record.requestEventId,
        );
        record.retainUntilMs = record.replayExpiresAtMs;
        return { result: true, put: [record], remove: [current.key] };
      }
      break;
    case 'dispatch':
      if (record.phase !== 'consumed') return none;
      record.phase = 'dispatched';
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
      if (record.mode === 'explicit_gating') record.retainUntilMs = null;
      break;
    default:
      throw new TypeError('Unknown payment state transition');
  }
  return { result: true, put: [record], remove: [] };
}
