import type { PaymentHandler, PaymentHandlerRequest } from '../types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';

export interface LnBolt11LnbitsPaymentHandlerOptions {
  /** LNbits instance base URL (e.g. `https://lnbits.example.com`). */
  lnbitsUrl: string;
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

  private readonly lnbitsUrl: string;
  private readonly lnbitsAdminKey: string;
  private readonly lnbitsBasicAuth?: string;

  public constructor(options: LnBolt11LnbitsPaymentHandlerOptions) {
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
      const encoded = Buffer.from(this.lnbitsBasicAuth).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  public async handle(req: PaymentHandlerRequest): Promise<void> {
    const response = await fetch(`${this.lnbitsUrl}/api/v1/payments`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        out: true,
        bolt11: req.pay_req,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LNbits pay_invoice failed: ${response.status} ${text}`);
    }

    const result = (await response.json()) as {
      payment_hash?: string;
    };

    if (!result.payment_hash) {
      throw new Error('LNbits payment returned no payment_hash');
    }
  }
}
