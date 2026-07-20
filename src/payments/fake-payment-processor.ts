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

  public async verifyPayment(params: PaymentProcessorVerifyParams) {
    // Honor abortSignal: a cancelled verify MUST reject, never resolve as settled.
    // Makes cancellation/timeout tests deterministic without relying solely on the
    // caller's withTimeout wrapper (mirrors rs-sdk's select on the cancel token).
    const signal = params.abortSignal;
    if (signal?.aborted) {
      throw signal.reason ?? new Error('verifyPayment aborted');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.verifyDelayMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('verifyPayment aborted'));
        },
        { once: true },
      );
    });
    return { _meta: { settled: true } };
  }
}
