import {
  PaymentProcessor,
  PaymentProcessorCreateParams,
  PaymentProcessorVerifyParams,
} from './types.js';

export interface FakePaymentProcessorOptions {
  /** The PMI this processor issues. @default 'fake' */
  pmi?: string;
  /** Artificial delay in ms for settlement verification. @default 50 */
  verifyDelayMs?: number;
  /** Artificial delay in ms for request creation. @default 0 */
  createDelayMs?: number;
  /** Optional TTL in seconds to include in payment_required. */
  ttl?: number;
}

/**
 * A fake payment processor that simulates issuing and verifying payments.
 */
export class FakePaymentProcessor implements PaymentProcessor {
  public readonly pmi: string;
  private readonly verifyDelayMs: number;
  private readonly createDelayMs: number;
  private readonly ttl: number | undefined;

  constructor(options: FakePaymentProcessorOptions = {}) {
    this.pmi = options.pmi ?? 'fake';
    this.verifyDelayMs = options.verifyDelayMs ?? 50;
    this.createDelayMs = options.createDelayMs ?? 0;
    this.ttl = options.ttl;
  }

  public async createPaymentRequired(params: PaymentProcessorCreateParams) {
    if (this.createDelayMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.createDelayMs),
      );
    }
    return {
      amount: params.amount,
      pay_req: `fake:${params.requestEventId}:${params.clientPubkey}:${params.amount}`,
      description: params.description,
      pmi: this.pmi,
      ...(this.ttl !== undefined && { ttl: this.ttl }),
    };
  }

  public async verifyPayment(_params: PaymentProcessorVerifyParams) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, this.verifyDelayMs),
    );
    return { _meta: { settled: true } };
  }
}
