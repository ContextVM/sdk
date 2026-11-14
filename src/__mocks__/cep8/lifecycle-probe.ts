import type { PaymentHandler, PaymentProcessor } from '../../payments/types.js';
import type { PaymentStateStore } from '../../payments/payment-state-store.js';

/** Monetary lifecycle stages observed independently of the request outcome. */
export const LIFECYCLE_STAGES = [
  'prepared',
  'approved',
  'submitted',
  'settled',
  'authorized',
  'consumed',
  'dispatched',
  'completed',
  'published',
  'received',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * Counts each stage at its own boundary: issuer preparation, client approval,
 * wallet submission, receiver settlement evidence, committed grant and claim,
 * handler entry/exit, result publication, and client completion.
 */
export class LifecycleProbe {
  public readonly log: LifecycleStage[] = [];
  /** Admissions answered as duplicates: replays that reached payment state. */
  public replays = 0;
  private readonly waiters: Array<{
    stage: LifecycleStage;
    count: number;
    resolve: () => void;
  }> = [];

  public mark(stage: LifecycleStage): void {
    this.log.push(stage);
    for (const waiter of [...this.waiters])
      if (this.count(waiter.stage) >= waiter.count) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
  }

  public count(stage: LifecycleStage): number {
    return this.log.filter((entry) => entry === stage).length;
  }

  /** Stage counts for exact assertions; unobserved stages are zero. */
  public counts(): Record<LifecycleStage, number> {
    return Object.fromEntries(
      LIFECYCLE_STAGES.map((stage) => [stage, this.count(stage)]),
    ) as Record<LifecycleStage, number>;
  }

  /** Bounded wait: rejects instead of leaving a test awaiting forever. */
  public reached(
    stage: LifecycleStage,
    count = 1,
    timeoutMs = 5000,
  ): Promise<void> {
    if (this.count(stage) >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Lifecycle stage ${stage} x${count} not reached`)),
        timeoutMs,
      );
      this.waiters.push({
        stage,
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  /** True when each listed stage first occurs after the previous one. */
  public ordered(...stages: LifecycleStage[]): boolean {
    const positions = stages.map((stage) => this.log.indexOf(stage));
    return positions.every(
      (position, index) =>
        position >= 0 &&
        (index === 0 || position > (positions[index - 1] ?? -1)),
    );
  }

  public processor(inner: PaymentProcessor): PaymentProcessor {
    return {
      pmi: inner.pmi,
      ...(inner.currencyUnit !== undefined && {
        currencyUnit: inner.currencyUnit,
      }),
      createPaymentRequired: async (params) => {
        const issued = await inner.createPaymentRequired(params);
        this.mark('prepared');
        return issued;
      },
      verifyPayment: async (params) => {
        const verified = await inner.verifyPayment(params);
        this.mark('settled');
        return verified;
      },
    };
  }

  public handler(inner: PaymentHandler): PaymentHandler {
    return {
      pmi: inner.pmi,
      handle: async (req) => {
        this.mark('submitted');
        await inner.handle(req);
      },
    };
  }

  public store(inner: PaymentStateStore): PaymentStateStore {
    return {
      policy: inner.policy,
      admit: async (input) => {
        const result = await inner.admit(input);
        if (result.status === 'claimed') this.mark('consumed');
        if (result.status === 'duplicate') this.replays++;
        return result;
      },
      transition: async (input) => {
        const changed = await inner.transition(input);
        if (changed && (input.type === 'settled' || input.type === 'grant'))
          this.mark('authorized');
        if (changed && input.type === 'consume') this.mark('consumed');
        return changed;
      },
      read: (key) => inner.read(key),
    };
  }
}
