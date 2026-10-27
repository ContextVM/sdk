import {
  runPaymentOperation,
  type PaymentFetch,
} from '../payment-cancellation.js';
import type { PaymentHandler, PaymentHandlerRequest } from '../types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';
import { encodeBase64 } from '../../core/utils/base64.js';

export interface LnBolt11LnbitsPaymentHandlerOptions {
  /** LNbits instance base URL (e.g. `https://lnbits.example.com`). */
  lnbitsUrl: string;
  /** Optional HTTP implementation for custom runtimes and fault injection. */
  fetch?: PaymentFetch;
  /** LNbits wallet admin key (required for outgoing payments). */
  lnbitsAdminKey: string;
  /** Optional HTTP Basic Auth credentials (`user:password`) for proxied instances. */
  lnbitsBasicAuth?: string;
}

/**
 * CEP-8 client payment handler for PMI `bitcoin-lightning-bolt11` backed by LNbits REST API.
 *
 * Pays BOLT11 invoices by calling the LNbits `/api/v1/payments` endpoint.
 */
export class LnBolt11LnbitsPaymentHandler implements PaymentHandler {
  public readonly pmi = PMI_BITCOIN_LIGHTNING_BOLT11;

  private readonly shutdown = new AbortController();
  private readonly fetch: PaymentFetch;
  private readonly lnbitsUrl: string;
  private readonly lnbitsAdminKey: string;
  private readonly lnbitsBasicAuth?: string;

  public constructor(options: LnBolt11LnbitsPaymentHandlerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.lnbitsUrl = options.lnbitsUrl.replace(/\/+$/, '');
    this.lnbitsAdminKey = options.lnbitsAdminKey;
    this.lnbitsBasicAuth = options.lnbitsBasicAuth;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Api-Key': this.lnbitsAdminKey,
    };
    if (this.lnbitsBasicAuth) {
      const encoded = encodeBase64(this.lnbitsBasicAuth);
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  /** Stops this adapter's local requests; remote payment may remain uncertain. */
  public async dispose(): Promise<void> {
    this.shutdown.abort();
  }

  public async handle(req: PaymentHandlerRequest): Promise<void> {
    return runPaymentOperation(req, 60_000, this.shutdown.signal, (signal) =>
      this.pay({ ...req, abortSignal: signal }),
    );
  }

  private async pay(req: PaymentHandlerRequest): Promise<void> {
    const response = await this.fetch(`${this.lnbitsUrl}/api/v1/payments`, {
      method: 'POST',
      signal: req.abortSignal,
      headers: this.buildHeaders(),
      body: JSON.stringify({
        out: true,
        bolt11: req.pay_req,
      }),
    });

    if (!response.ok) {
      throw new Error(`LNbits pay_invoice failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      payment_hash?: string;
    };

    if (!result.payment_hash) {
      throw new Error('LNbits payment returned no payment_hash');
    }
  }
}
