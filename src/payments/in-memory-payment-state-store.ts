import type {
  PaymentStateAdmission,
  PaymentStateAdmissionResult,
  PaymentStatePolicy,
  PaymentStateRecord,
  PaymentStateStore,
  PaymentStateTransition,
} from './payment-state-store.js';
import { createPaymentStatePolicy } from './payment-state-store.js';
import {
  admitPaymentState,
  canCollectPaymentRecord,
  isLivePaymentLease,
  transitionPaymentState,
} from './payment-state-machine.js';

let memoryStoreSequence = 0;

/** Single-process default; live grants and uncertain outcomes are never evicted. */
export class InMemoryPaymentStateStore implements PaymentStateStore {
  public readonly policy: PaymentStatePolicy;
  // Collect by replay deadlines, not LRU recency: evicting a tombstone can repeat payment or execution.
  private readonly records = new Map<string, PaymentStateRecord>();
  private observedAtMs = 0;
  private readonly storeSequence = ++memoryStoreSequence;
  private attemptSequence = 0;

  public constructor(
    options: Partial<PaymentStatePolicy> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.policy = createPaymentStatePolicy(options);
  }

  /** Atomically claims a grant or reserves an invoice before any asynchronous work. */
  public async admit(
    input: PaymentStateAdmission,
  ): Promise<PaymentStateAdmissionResult> {
    const now = this.timestamp();
    if (
      !Number.isSafeInteger(this.storeSequence) ||
      this.attemptSequence >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Payment generation space exhausted');
    for (const [key, record] of this.records) {
      if (canCollectPaymentRecord(record, now)) this.records.delete(key);
    }
    const change = admitPaymentState(
      input,
      {
        record: this.records.get(input.key),
        execution: [...this.records.values()].find(
          (record) =>
            record.key !== input.key &&
            record.clientPubkey === input.clientPubkey &&
            record.eventIds.includes(input.requestEventId),
        ),
        total: this.records.size,
        pending: [...this.records.values()].filter((record) =>
          isLivePaymentLease(record, now),
        ).length,
      },
      this.policy,
      now,
      `${this.storeSequence}.${++this.attemptSequence}`,
    );
    for (const key of change.remove) this.records.delete(key);
    for (const record of change.put) this.records.set(record.key, record);
    return change.result;
  }

  /** Commits only transitions belonging to the current attempt generation. */
  public async transition(input: PaymentStateTransition): Promise<boolean> {
    const change = transitionPaymentState(
      input,
      this.records.get(input.key),
      this.timestamp(),
      this.policy,
    );
    for (const key of change.remove) this.records.delete(key);
    for (const record of change.put) this.records.set(record.key, record);
    return change.result;
  }

  /** Returns a defensive recovery snapshot without exposing mutable store state. */
  public async read(key: string): Promise<PaymentStateRecord | undefined> {
    const record = this.records.get(key);
    return record && structuredClone(record);
  }

  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error('Invalid payment clock');
    this.observedAtMs = Math.max(now, this.observedAtMs);
    return this.observedAtMs;
  }
}
