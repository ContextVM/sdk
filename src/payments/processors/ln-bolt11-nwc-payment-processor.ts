import type { RelayHandler } from '../../core/interfaces.js';
import type {
  PaymentProcessor,
  PaymentProcessorCreateParams,
  PaymentProcessorVerifyParams,
} from '../types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';
import { parseNwcConnectionString } from '../nip47/connection.js';
import { NwcClient } from '../nip47/nwc-client.js';
import type { NwcInvoiceResult, NwcMakeInvoiceParams } from '../nip47/types.js';
import { ApplesauceRelayPool } from '../../relay/applesauce-relay-pool.js';
import { createLogger, type Logger } from '../../core/utils/logger.js';
import { satsToMsats } from '../nip47/utils.js';
import { LruCache } from '../../core/utils/lru-cache.js';
import { sleepWithAbort } from '../../core/utils/utils.js';

export interface LnBolt11NwcPaymentProcessorOptions {
  /** NIP-47 `nostr+walletconnect://...` connection string. */
  nwcConnectionString: string;
  /** Optional relay handler to reuse; defaults to an ApplesauceRelayPool built from the connection relays. */
  relayHandler?: RelayHandler;

  /** Fallback TTL in seconds if wallet does not provide expires_at. @default 300 */
  ttlSeconds?: number;
  /** `make_invoice.expiry` in seconds. @default ttlSeconds */
  invoiceExpirySeconds?: number;
  /** Poll interval for `lookup_invoice`. @default 1500 */
  pollIntervalMs?: number;
  /** Per-request response timeout. @default 60_000 */
  responseTimeoutMs?: number;

  /**
   * Maximum number of in-flight invoice verifications to dedupe.
   *
   * This is a scalability and relay-load guardrail.
   * @default 5000
   */
  maxInFlightVerifications?: number;

  /**
   * Maximum number of invoice->payment_hash mappings to cache.
   *
   * This reduces the need to rely on invoice-string lookups when wallets support payment_hash.
   * @default 10000
   */
  invoiceHashCacheSize?: number;
}

/**
 * CEP-8 server payment processor for PMI `bitcoin-lightning-bolt11` backed by NIP-47 (NWC).
 */
export class LnBolt11NwcPaymentProcessor implements PaymentProcessor {
  public readonly pmi = PMI_BITCOIN_LIGHTNING_BOLT11;

  private readonly nwc: NwcClient;
  private readonly ttlSeconds: number;
  private readonly invoiceExpirySeconds: number;
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;

  // Dedupe concurrent verifyPayment() calls for the same pay_req to avoid amplifying
  // relay + wallet load under duplicate delivery.
  private readonly inFlightVerifications: LruCache<
    Promise<{ _meta?: Record<string, unknown> }>
  >;

  // Cache invoice -> payment_hash when wallets provide it.
  private readonly invoiceHashCache: LruCache<string>;

  public constructor(options: LnBolt11NwcPaymentProcessorOptions) {
    const connection = parseNwcConnectionString(options.nwcConnectionString);
    const relayHandler =
      options.relayHandler ?? new ApplesauceRelayPool([...connection.relays]);

    this.nwc = new NwcClient({
      relayHandler,
      connection,
      responseTimeoutMs: options.responseTimeoutMs,
    });

    this.ttlSeconds = options.ttlSeconds ?? 300;
    this.invoiceExpirySeconds = options.invoiceExpirySeconds ?? this.ttlSeconds;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.logger = createLogger('payments/nwc-processor');

    this.inFlightVerifications = new LruCache<
      Promise<{ _meta?: Record<string, unknown> }>
    >(options.maxInFlightVerifications ?? 5000);
    this.invoiceHashCache = new LruCache<string>(
      options.invoiceHashCacheSize ?? 10000,
    );
  }

  private computeNextDelayMs(params: { attempt: number }): number {
    // Prefer fast early checks (most invoices settle quickly), then back off.
    // Keep a floor for legacy configs that rely on a predictable pollIntervalMs.
    const scheduleMs = [500, 750, 1000, 1500, 2500, 4000, 6500, 10_000, 15_000];

    const base = scheduleMs[Math.min(params.attempt, scheduleMs.length - 1)]!;
    const flooredBase = Math.max(this.pollIntervalMs, base);

    // Add small jitter to avoid stampeding on shared relay/wallet infra.
    const jitter = Math.floor(Math.random() * 250);
    return flooredBase + jitter;
  }

  private isSettledInvoice(result: NwcInvoiceResult | null): boolean {
    // Wallets vary: some set `state`, some only set `settled_at`, some include `preimage`.
    // Treat any of these signals as settlement.
    if (!result) return false;
    if (result.state === 'settled') return true;
    if (typeof result.settled_at === 'number') return true;
    if (typeof result.preimage === 'string' && result.preimage.length > 0)
      return true;
    return false;
  }

  private getReceiptFromInvoiceResult(params: {
    result: NwcInvoiceResult | null;
    requestEventId: string;
  }): string {
    const { result, requestEventId } = params;

    // Prefer stable identifiers; avoid leaking preimage.
    if (
      typeof result?.payment_hash === 'string' &&
      result.payment_hash.length > 0
    ) {
      return result.payment_hash;
    }

    // Some wallets do not provide `payment_hash` on lookup results. Still produce a stable
    // settlement identifier string for correlation.
    const settledAt =
      typeof result?.settled_at === 'number' ? result.settled_at : undefined;
    return `settled:${requestEventId}${settledAt ? `:${settledAt}` : ''}`;
  }

  public async createPaymentRequired(
    params: PaymentProcessorCreateParams,
  ): Promise<{
    amount: number;
    pay_req: string;
    description?: string;
    pmi: string;
    ttl?: number;
  }> {
    const request: NwcMakeInvoiceParams = {
      amount: satsToMsats(params.amount),
      description: params.description,
      expiry: this.invoiceExpirySeconds,
    };

    const response = await this.nwc.request({
      method: 'make_invoice',
      resultType: 'make_invoice',
      request: { method: 'make_invoice', params: request },
    });

    if (response.error) {
      throw new Error(
        `NWC make_invoice failed: ${response.error.code} (${response.error.message})`,
      );
    }

    const invoice = (response.result as NwcInvoiceResult | null)?.invoice;
    if (!invoice) {
      throw new Error('NWC make_invoice returned no invoice');
    }

    const paymentHash = (response.result as NwcInvoiceResult | null)
      ?.payment_hash;
    if (typeof paymentHash === 'string' && paymentHash.length > 0) {
      this.invoiceHashCache.set(invoice, paymentHash);
    }

    // Keep TTL simple and predictable. Some providers return non-standard `expires_at`.
    const ttl = this.ttlSeconds;

    return {
      amount: params.amount,
      pay_req: invoice,
      description: params.description,
      pmi: this.pmi,
      ttl,
    };
  }

  public async verifyPayment(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    const existing = this.inFlightVerifications.get(params.pay_req);
    if (existing) {
      return await existing;
    }

    const run = this.verifyPaymentInternal(params).finally(() => {
      this.inFlightVerifications.delete(params.pay_req);
    });
    this.inFlightVerifications.set(params.pay_req, run);
    return await run;
  }

  private async verifyPaymentInternal(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    // Note: server-payments middleware already bounds overall time by the `ttl` it emitted.
    // We still keep this loop tight and predictable.
    let attempt = 0;
    while (true) {
      if (params.abortSignal?.aborted) {
        throw new Error('verifyPayment aborted');
      }

      const cachedPaymentHash = this.invoiceHashCache.get(params.pay_req);

      const response = await this.nwc.request({
        method: 'lookup_invoice',
        resultType: 'lookup_invoice',
        request: {
          method: 'lookup_invoice',
          params: cachedPaymentHash
            ? { payment_hash: cachedPaymentHash }
            : { invoice: params.pay_req },
        },
      });

      if (response.error) {
        // NOT_FOUND can happen if the wallet is lagging; treat as pending.
        if (response.error.code !== 'NOT_FOUND') {
          throw new Error(
            `NWC lookup_invoice failed: ${response.error.code} (${response.error.message})`,
          );
        }
      } else {
        const result = response.result as NwcInvoiceResult | null;
        this.logger.debug('lookup_invoice result', {
          requestEventId: params.requestEventId,
          state: result?.state,
          hasPreimage: Boolean(result?.preimage),
          hasSettledAt: typeof result?.settled_at === 'number',
          hasPaymentHash: Boolean(result?.payment_hash),
        });

        if (
          !cachedPaymentHash &&
          typeof result?.payment_hash === 'string' &&
          result.payment_hash.length > 0
        ) {
          this.invoiceHashCache.set(params.pay_req, result.payment_hash);
        }

        if (this.isSettledInvoice(result)) {
          // Prefer payment_hash as a stable identifier (avoid exposing preimages).
          const paymentHash = this.getReceiptFromInvoiceResult({
            result,
            requestEventId: params.requestEventId,
          });
          return { _meta: { payment_hash: paymentHash } };
        }

        const state = result?.state;
        if (state === 'expired' || state === 'failed') {
          throw new Error(`Invoice ${state}`);
        }
      }

      const delayMs = this.computeNextDelayMs({ attempt });
      attempt += 1;
      await sleepWithAbort({ ms: delayMs, abortSignal: params.abortSignal });
    }
  }
}
