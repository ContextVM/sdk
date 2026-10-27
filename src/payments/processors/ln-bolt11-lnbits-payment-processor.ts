import {
  runPaymentOperation,
  type PaymentFetch,
} from '../payment-cancellation.js';
import type {
  PaymentRequired,
  PaymentProcessor,
  PaymentProcessorCreateParams,
  PaymentProcessorVerifyParams,
} from '../types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';
import { createLogger, type Logger } from '../../core/utils/logger.js';
import { sleepWithAbort } from '../../core/utils/utils.js';
import { encodeBase64 } from '../../core/utils/base64.js';

export interface LnBolt11LnbitsPaymentProcessorOptions {
  /** LNbits instance base URL (e.g. `https://lnbits.example.com`). */
  lnbitsUrl: string;
  /** Optional HTTP implementation for custom runtimes and fault injection. */
  fetch?: PaymentFetch;
  /** LNbits wallet invoice/read key. */
  lnbitsApiKey: string;
  /** Optional HTTP Basic Auth credentials (`user:password`) for proxied instances. */
  lnbitsBasicAuth?: string;

  /** Fallback TTL in seconds for the payment request. @default 300 */
  ttlSeconds?: number;
  /** Invoice expiry in seconds passed to LNbits. @default ttlSeconds */
  invoiceExpirySeconds?: number;
  /** Poll interval for payment verification. @default 1500 */
  pollIntervalMs?: number;
}

/**
 * CEP-8 server payment processor for PMI `bitcoin-lightning-bolt11` backed by LNbits REST API.
 *
 * Creates BOLT11 invoices via the LNbits `/api/v1/payments` endpoint and polls
 * for settlement using the same API.
 */
export class LnBolt11LnbitsPaymentProcessor implements PaymentProcessor {
  /** Native amount unit; conversion to millisatoshis happens inside the adapter. */
  public readonly currencyUnit = 'sats';
  public readonly pmi = PMI_BITCOIN_LIGHTNING_BOLT11;

  private readonly shutdown = new AbortController();
  private readonly fetch: PaymentFetch;
  private readonly lnbitsUrl: string;
  private readonly lnbitsApiKey: string;
  private readonly lnbitsBasicAuth?: string;
  private readonly ttlSeconds: number;
  private readonly invoiceExpirySeconds: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  public constructor(options: LnBolt11LnbitsPaymentProcessorOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.lnbitsUrl = options.lnbitsUrl.replace(/\/+$/, '');
    this.lnbitsApiKey = options.lnbitsApiKey;
    this.lnbitsBasicAuth = options.lnbitsBasicAuth;
    this.ttlSeconds = options.ttlSeconds ?? 300;
    this.invoiceExpirySeconds = options.invoiceExpirySeconds ?? this.ttlSeconds;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.logger = createLogger('payments/lnbits-processor');
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Api-Key': this.lnbitsApiKey,
    };
    if (this.lnbitsBasicAuth) {
      const encoded = encodeBase64(this.lnbitsBasicAuth);
      headers['Authorization'] = `Basic ${encoded}`;
    }
    return headers;
  }

  /** Cancels work owned by this adapter. */
  public async dispose(): Promise<void> {
    this.shutdown.abort();
  }

  /** Creates an invoice under the supplied cancellation/deadline context. */
  public async createPaymentRequired(
    params: PaymentProcessorCreateParams,
  ): Promise<PaymentRequired> {
    return runPaymentOperation(
      params,
      this.ttlSeconds * 1000,
      this.shutdown.signal,
      (signal) => this.createInternal({ ...params, abortSignal: signal }),
    );
  }

  private async createInternal(
    params: PaymentProcessorCreateParams,
  ): Promise<PaymentRequired> {
    const body = JSON.stringify({
      out: false,
      amount: params.amount,
      memo:
        params.description ??
        `CVM payment: ${params.requestEventId.slice(0, 8)}`,
      expiry: this.invoiceExpirySeconds,
    });

    const response = await this.fetch(`${this.lnbitsUrl}/api/v1/payments`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body,
      signal: params.abortSignal,
    });

    if (!response.ok) {
      throw new Error(`LNbits create invoice failed: ${response.status}`);
    }

    const result = (await response.json()) as {
      payment_request: string;
      payment_hash: string;
    };

    if (!result.payment_request) {
      throw new Error('LNbits returned no payment_request');
    }

    this.logger.debug('Invoice created', {
      requestEventId: params.requestEventId,
      paymentHash: result.payment_hash,
      amount: params.amount,
    });

    return {
      amount: params.amount,
      pay_req: result.payment_request,
      description: params.description,
      pmi: this.pmi,
      ttl: this.ttlSeconds,
    };
  }

  /** Authenticated receiver-side status lookup; does not pay or create invoices. */
  public async verifyPayment(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    return runPaymentOperation(
      params,
      this.ttlSeconds * 1000,
      this.shutdown.signal,
      (signal) => this.verifyInternal({ ...params, abortSignal: signal }),
    );
  }

  private async verifyInternal(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    // We need the payment hash to check status. Derive it from the invoice
    // by first looking it up via the decoded invoice endpoint, or by checking
    // all recent payments. The simplest approach: decode the bolt11 to get the hash.
    const paymentHash = await this.getPaymentHashFromInvoice(
      params.pay_req,
      params.abortSignal,
    );

    while (true) {
      if (params.abortSignal?.aborted) {
        throw new Error('verifyPayment aborted');
      }

      const response = await this.fetch(
        `${this.lnbitsUrl}/api/v1/payments/${paymentHash}`,
        {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: params.abortSignal,
        },
      );

      if (response.ok) {
        const result = (await response.json()) as { paid: boolean };

        this.logger.debug('Payment check', {
          requestEventId: params.requestEventId,
          paymentHash,
          paid: result.paid,
        });

        if (result.paid === true) {
          return { _meta: { payment_hash: paymentHash } };
        }
      } else {
        this.logger.debug('Payment check request failed', {
          status: response.status,
          paymentHash,
        });
      }

      await sleepWithAbort({
        ms: this.pollIntervalMs,
        abortSignal: params.abortSignal,
      });
    }
  }

  /**
   * Extract payment hash from a BOLT11 invoice by checking it against LNbits.
   * LNbits returns the payment_hash when creating an invoice, but verifyPayment
   * only receives pay_req. We decode it via LNbits decode endpoint.
   */
  private async getPaymentHashFromInvoice(
    bolt11: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const response = await this.fetch(
      `${this.lnbitsUrl}/api/v1/payments/decode`,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ data: bolt11 }),
        signal: abortSignal,
      },
    );

    if (response.ok) {
      const decoded = (await response.json()) as { payment_hash?: string };
      if (decoded.payment_hash) {
        return decoded.payment_hash;
      }
    }

    // Fallback: search recent payments for matching bolt11
    abortSignal?.throwIfAborted();
    const paymentsResponse = await this.fetch(
      `${this.lnbitsUrl}/api/v1/payments?limit=50`,
      {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: abortSignal,
      },
    );

    if (paymentsResponse.ok) {
      const payments = (await paymentsResponse.json()) as Array<{
        payment_hash: string;
        bolt11: string;
      }>;
      const match = payments.find((p) => p.bolt11 === bolt11);
      if (match) {
        return match.payment_hash;
      }
    }

    throw new Error('Could not resolve payment hash from invoice');
  }
}
