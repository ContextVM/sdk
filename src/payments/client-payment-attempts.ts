import type { PaymentOption } from './types.js';
import { ClientPaymentError } from './client-payment-validation.js';

type AttemptOutcome = 'in_flight' | 'handled' | 'declined' | 'unknown';

/** A local payment action; handled means wallet callback returned, not settlement. */
export interface ClientPaymentAttempt {
  outcome: AttemptOutcome;
  completion: Promise<void>;
  complete: (outcome: Exclude<AttemptOutcome, 'in_flight'>) => void;
}

/**
 * Wrapper-scoped attempt history. A Nostr wrapper is bound to one authenticated
 * server; generic wrappers use their transport instance as the peer boundary.
 * No live/completed/unknown entry is evicted and silently made payable again.
 */
export class ClientPaymentAttempts {
  private readonly entries = new Map<
    string,
    { amount: number; attempt: ClientPaymentAttempt }
  >();

  public constructor(private readonly maxEntries: number) {}

  private key(option: PaymentOption): string {
    return JSON.stringify([option.pmi, option.pay_req]);
  }

  /** Finds a prior action without reserving or paying any new option. */
  public find(
    options: readonly PaymentOption[],
  ): ClientPaymentAttempt | undefined {
    let found: ClientPaymentAttempt | undefined;
    for (const option of options) {
      const prior = this.entries.get(this.key(option));
      if (prior) {
        if (prior.amount !== option.amount) {
          throw new ClientPaymentError(
            'payment_offer_changed',
            'Payment amount changed for an existing payment identity',
          );
        }
        if (
          !found ||
          (found.outcome !== 'unknown' &&
            (prior.attempt.outcome === 'unknown' ||
              prior.attempt.outcome === 'in_flight'))
        )
          found = prior.attempt;
      }
    }
    return found;
  }

  /** Atomically reserves all selectable options before external approval work. */
  public reserve(
    options: readonly PaymentOption[],
    signal: AbortSignal,
  ): ClientPaymentAttempt {
    const unique = new Map(options.map((option) => [this.key(option), option]));
    if (this.entries.size + unique.size > this.maxEntries) {
      throw new ClientPaymentError(
        'payment_attempt_capacity',
        'Client payment attempt capacity reached',
      );
    }
    let resolve!: () => void;
    const attempt: ClientPaymentAttempt = {
      outcome: 'in_flight',
      completion: new Promise<void>((done) => {
        resolve = done;
      }),
      complete: (outcome): void => {
        if (attempt.outcome !== 'in_flight') return;
        attempt.outcome = outcome;
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
    };
    const onAbort = (): void => attempt.complete('unknown');
    for (const [key, option] of unique) {
      this.entries.set(key, { amount: option.amount, attempt });
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return attempt;
  }
}
