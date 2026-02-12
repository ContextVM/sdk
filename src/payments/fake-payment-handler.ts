import { PaymentHandler, PaymentHandlerRequest } from './types.js';

export interface FakePaymentHandlerOptions {
  /** The PMI this handler advertises. @default 'fake' */
  pmi?: string;
  /** Artificial delay in ms to simulate a wallet action. @default 50 */
  delayMs?: number;
}

/**
 * A fake payment handler that simulates wallet processing using a delay.
 *
 * It does not publish any protocol messages.
 */
export class FakePaymentHandler implements PaymentHandler {
  public readonly pmi: string;
  private readonly delayMs: number;

  constructor(options: FakePaymentHandlerOptions = {}) {
    this.pmi = options.pmi ?? 'fake';
    this.delayMs = options.delayMs ?? 50;
  }

  public async handle(_req: PaymentHandlerRequest): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
  }
}
