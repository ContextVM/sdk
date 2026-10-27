import type { JSONRPCResponse } from '@contextvm/mcp-sdk/types.js';
import type { RouteSnapshot } from '../transport/nostr-server/correlation-store.js';
import type { PaymentResultJournal } from './payment-delivery.js';
import type { PaymentProcessor } from './types.js';
import type {
  PaymentStateRecord,
  PaymentStateStore,
} from './payment-state-store.js';
import { paymentEventKey } from './payment-state-store.js';
import {
  paymentOperation,
  type PaymentOperationContext,
} from './payment-cancellation.js';
import {
  recordPaymentOutcome,
  type PaymentOutcomeOptions,
} from './payment-outcomes.js';

/** An application-visible remedy, never an automatic refund or handler rerun. */
export interface PaymentRecoveryResult {
  status:
    | 'settled'
    | 'superseded'
    | 'unknown'
    | 'grant_available'
    | 'grant_expired'
    | 'consumed'
    | 'undelivered'
    | 'published';
  remedy:
    | 'retry_invocation'
    | 'retry_publication'
    | 'reconcile_settlement'
    | 'application_policy'
    | 'none';
  record?: PaymentStateRecord;
}

/** Reconciles a recorded invoice using its authenticated provider, without issuing or paying another invoice. */
export async function reconcilePaymentAttempt(
  params: PaymentOperationContext & {
    store: PaymentStateStore;
    key: string;
    generation: string;
    processors: readonly PaymentProcessor[];
    /** Explicit application policy for a recovered authorization lifetime. */
    authorizationTtlMs: number;
    outcomes?: PaymentOutcomeOptions;
  },
): Promise<PaymentRecoveryResult> {
  const record = await params.store.read(params.key);
  if (!record || record.generation !== params.generation)
    return { status: 'superseded', remedy: 'application_policy' };
  const observed = paymentRecoveryStatus(record);
  if (
    !['pending', 'unknown', 'expired'].includes(record.phase) ||
    record.settlement
  )
    return observed;
  const processor = params.processors.find(
    (p) => p.pmi === record.invoice?.pmi,
  );
  if (!processor || !record.invoice) {
    recordPaymentOutcome(
      params.outcomes ?? {},
      record,
      'reconciliation_required',
      'application_policy',
    );
    return { status: 'unknown', remedy: 'application_policy', record };
  }
  const deadlineMs = Math.min(
    params.deadlineMs ?? Infinity,
    Date.now() + 60_000,
  );
  const leaseMs = Math.floor(deadlineMs - Date.now());
  if (leaseMs < 1 || params.abortSignal?.aborted)
    return { status: 'unknown', remedy: 'reconcile_settlement', record };
  const owner = `${Date.now()}:${++publicationSequence}:${Math.random()}:${Math.random()}`;
  if (
    !(await params.store.transition({
      key: record.key,
      generation: record.generation,
      type: 'reconciliation_claim',
      owner,
      leaseMs,
    }))
  )
    return { status: 'unknown', remedy: 'reconcile_settlement', record };
  const operation = paymentOperation({ ...params, deadlineMs });
  try {
    operation.signal.throwIfAborted();
    await operation.wait(
      processor.verifyPayment({
        pay_req: record.invoice.pay_req,
        requestEventId: record.requestEventId,
        clientPubkey: record.clientPubkey,
        abortSignal: operation.signal,
        deadlineMs: params.deadlineMs,
      }),
    );
    operation.signal.throwIfAborted();
    if (
      !(await params.store.transition({
        key: record.key,
        generation: record.generation,
        type: 'settled',
        ttlMs: params.authorizationTtlMs,
        owner,
      }))
    )
      return { status: 'superseded', remedy: 'application_policy' };
    const recovered = await params.store.read(record.key);
    recordPaymentOutcome(params.outcomes ?? {}, record, 'reconciled');
    return recovered
      ? paymentRecoveryStatus(recovered)
      : { status: 'superseded', remedy: 'application_policy' };
  } finally {
    operation.dispose();
    await params.store.transition({
      key: record.key,
      generation: record.generation,
      type: 'reconciliation_release',
      owner,
    });
  }
}

/** Explains stored recovery state without interpreting publication as receipt. */
export function paymentRecoveryStatus(
  record: PaymentStateRecord,
): PaymentRecoveryResult {
  if (record.delivery?.status === 'published')
    return { status: 'published', remedy: 'none', record };
  if (record.delivery)
    return { status: 'undelivered', remedy: 'retry_publication', record };
  if (['consumed', 'dispatched'].includes(record.phase))
    return { status: 'consumed', remedy: 'application_policy', record };
  if (record.phase === 'granted')
    return (record.grantExpiresAtMs ?? 0) > Date.now()
      ? { status: 'grant_available', remedy: 'retry_invocation', record }
      : { status: 'grant_expired', remedy: 'application_policy', record };
  if (record.settlement)
    return { status: 'settled', remedy: 'retry_invocation', record };
  return { status: 'unknown', remedy: 'reconcile_settlement', record };
}

let publicationSequence = 0;

/** Store-backed publication journal; retries never invoke application handlers.
 * The default in-memory store retains results only for the lifetime of that store.
 */
export class PaymentResultRecovery implements PaymentResultJournal {
  public constructor(
    private readonly store: PaymentStateStore,
    private readonly options: PaymentOutcomeOptions & {
      publicationLeaseMs: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.publicationLeaseMs) ||
      options.publicationLeaseMs < 1 ||
      options.publicationLeaseMs > 2_147_483_647
    )
      throw new TypeError('Invalid publication lease');
  }

  /** Persists a final result even when its publication is deferred behind an open stream. */
  public async retain(
    eventId: string,
    response: JSONRPCResponse,
    snapshot: RouteSnapshot,
  ): Promise<void> {
    const key = paymentEventKey(snapshot.route.clientPubkey, eventId);
    const record = await this.store.read(key);
    if (!record) return;
    if (
      !(await this.store.transition({
        key,
        generation: record.generation,
        type: 'result',
        delivery: {
          response,
          snapshot,
          status: 'pending',
          acknowledgedFrames: 0,
        },
      }))
    )
      throw new Error('Paid result differs from the recorded execution result');
    recordPaymentOutcome(this.options, record, 'result_recorded');
  }

  /** Records the full correlated result before any publication side effect and obtains one worker lease. */
  public async prepare(
    eventId: string,
    response: JSONRPCResponse,
    snapshot: RouteSnapshot,
  ): ReturnType<PaymentResultJournal['prepare']> {
    const key = paymentEventKey(snapshot.route.clientPubkey, eventId);
    const record = await this.store.read(key);
    const noop = {
      publish: true,
      acknowledgedFrames: 0,
      framePublished: async (): Promise<void> => {},
      complete: async (): Promise<void> => {},
      failed: async (): Promise<void> => {},
    };
    if (!record) return noop;
    const fence = { key, generation: record.generation };
    await this.retain(eventId, response, snapshot);
    // An ownership fence, not an authentication secret. No crypto globals are required on Node 18.
    const owner = `${Date.now()}:${++publicationSequence}:${Math.random()}:${Math.random()}`;
    if (
      !(await this.store.transition({
        ...fence,
        type: 'publication_claim',
        owner,
        leaseMs: this.options.publicationLeaseMs,
      }))
    ) {
      const current = await this.store.read(key);
      if (current?.delivery?.status === 'published')
        return { ...noop, publish: false };
      throw new Error(
        'Paid result publication is already leased; reconcile before retrying',
      );
    }
    const current = await this.store.read(key);
    if (current?.delivery?.owner !== owner)
      throw new Error('Paid result publication ownership lost');
    return {
      publish: true,
      acknowledgedFrames: current.delivery.acknowledgedFrames,
      chunkSizeBytes: current.delivery.chunkSizeBytes,
      framePublished: async (frames, chunkSizeBytes): Promise<void> => {
        if (
          !(await this.store.transition({
            ...fence,
            type: 'publication_progress',
            leaseMs: this.options.publicationLeaseMs,
            owner,
            frames,
            chunkSizeBytes,
          }))
        )
          throw new Error('Paid result publication fence lost');
      },
      complete: async (): Promise<void> => {
        if (
          !(await this.store.transition({ ...fence, type: 'published', owner }))
        )
          throw new Error(
            'Paid publication acknowledgement could not be recorded',
          );
        recordPaymentOutcome(this.options, record, 'published');
      },
      failed: async (): Promise<void> => {
        await this.store.transition({
          ...fence,
          type: 'publication_failed',
          owner,
        });
        recordPaymentOutcome(
          this.options,
          record,
          'publication_failed',
          'retry_publication',
        );
      },
    };
  }

  /** Restores a recorded result's route so callers can republish it without repeating execution. */
  public async replay(
    clientPubkey: string,
    eventId: string,
    restore: (snapshot: RouteSnapshot) => void,
    send: (response: JSONRPCResponse) => Promise<void>,
  ): Promise<void> {
    const record = await this.store.read(
      paymentEventKey(clientPubkey, eventId),
    );
    if (!record?.delivery)
      throw new Error(
        'No recorded paid result; application recovery policy required',
      );
    if (record.delivery.status === 'published') return;
    restore(structuredClone(record.delivery.snapshot));
    await send(structuredClone(record.delivery.response));
  }
}
