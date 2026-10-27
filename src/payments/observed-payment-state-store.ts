import type {
  PaymentStateStore,
  PaymentStateAdmission,
  PaymentStateAdmissionResult,
  PaymentStateTransition,
  PaymentStateRecord,
} from './payment-state-store.js';
import {
  recordPaymentOutcome,
  emitPaymentOutcome,
  paymentInvoiceDigest,
  type PaymentOutcomeKind,
  type PaymentOutcomeOptions,
} from './payment-outcomes.js';

/** Optional observation over the same atomic store; observer failures never become payment failures. */
export class ObservedPaymentStateStore implements PaymentStateStore {
  public readonly policy: PaymentStateStore['policy'];
  public constructor(
    private readonly backend: PaymentStateStore,
    private readonly options: PaymentOutcomeOptions,
  ) {
    this.policy = backend.policy;
  }
  /** Observes admission after the backend has committed. */
  public async admit(
    input: PaymentStateAdmission,
  ): Promise<PaymentStateAdmissionResult> {
    let result: PaymentStateAdmissionResult;
    try {
      result = await this.backend.admit(input);
    } catch (error) {
      emitPaymentOutcome(this.options, {
        kind: 'unknown',
        atMs: Date.now(),
        identity: paymentInvoiceDigest(input.key),
        requestEventId: input.requestEventId,
        remedy: 'reconcile_settlement',
      });
      throw error;
    }
    if (result.record) {
      const kind =
        result.status === 'claimed'
          ? 'claim'
          : result.status === 'reserved'
            ? 'attempt'
            : result.status === 'expired'
              ? 'expired'
              : result.status === 'unknown'
                ? 'unknown'
                : undefined;
      if (kind) recordPaymentOutcome(this.options, result.record, kind);
    }
    if (result.status === 'capacity')
      emitPaymentOutcome(this.options, {
        kind: 'exhausted',
        atMs: Date.now(),
        identity: paymentInvoiceDigest(input.key),
        requestEventId: input.requestEventId,
      });
    return result;
  }
  /** Correlation reads are best effort and cannot change the underlying transition's success. */
  public async transition(input: PaymentStateTransition): Promise<boolean> {
    let changed: boolean;
    try {
      changed = await this.backend.transition(input);
    } catch (error) {
      emitPaymentOutcome(this.options, {
        kind: 'unknown',
        atMs: Date.now(),
        identity: paymentInvoiceDigest(input.key),
        attempt: input.generation,
        remedy: 'application_policy',
      });
      throw error;
    }
    if (changed) {
      const kinds: Partial<
        Record<PaymentStateTransition['type'], PaymentOutcomeKind>
      > = {
        bind: 'offer',
        grant: 'grant',
        settled: 'verified',
        consume: 'claim',
        dispatch: 'execution',
        expire: 'expired',
        uncertain: 'unknown',
      };
      const kind = kinds[input.type];
      if (kind) {
        try {
          const record = await this.backend.read(input.key);
          if (record) {
            recordPaymentOutcome(this.options, record, kind);
            if (input.type === 'settled' && record.phase === 'granted')
              recordPaymentOutcome(this.options, record, 'grant');
          }
        } catch {
          /* Observation is optional; committed state remains authoritative. */
        }
      }
    }
    return changed;
  }
  /** Reads the original backend; no fallback or reconstruction of authorization. */
  public async read(key: string): Promise<PaymentStateRecord | undefined> {
    return this.backend.read(key);
  }
}
