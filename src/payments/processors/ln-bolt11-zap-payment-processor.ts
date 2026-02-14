import { kinds, type Filter, type NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import type { RelayHandler } from '../../core/interfaces.js';
import { ApplesauceRelayPool } from '../../relay/applesauce-relay-pool.js';
import { createLogger, type Logger } from '../../core/utils/logger.js';
import { LruCache } from '../../core/utils/lru-cache.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';
import { fetchLnurlPayParams, requestZapInvoice } from '../nip57/lnurl.js';
import {
  createZapRequest,
  getBolt11FromZapReceipt,
} from '../nip57/zap-events.js';
import type {
  PaymentProcessor,
  PaymentProcessorCreateParams,
  PaymentProcessorVerifyParams,
} from '../types.js';

export interface LnBolt11ZapPaymentProcessorOptions {
  /** Lightning address (LUD-16), e.g. `alice@example.com`. */
  lnAddress: string;

  /** Optional relay handler to reuse; otherwise a new ApplesauceRelayPool is created. */
  relayHandler?: RelayHandler;
  /** Relay URLs used both in zap request `relays` tag and to subscribe for zap receipts. */
  relayUrls?: string[];

  /** Time-to-live in seconds returned in `payment_required`. @default 300 */
  ttlSeconds?: number;

  /** Maximum number of in-flight invoice verifications to dedupe. @default 5000 */
  maxInFlightVerifications?: number;
  /** Maximum number of pending invoice issuances to remember. @default 10000 */
  maxPendingInvoices?: number;
}

type PendingInvoiceMeta = {
  expectedZapperPubkey: string;
  since: number;
  amountMsats: number;
};

/**
 * CEP-8 server payment processor for PMI `bitcoin-lightning-bolt11` backed by NIP-57 zap receipts.
 *
 * This issues a BOLT11 invoice via LNURL-pay zap request (kind 9734) and verifies settlement by
 * subscribing for zap receipts (kind 9735).
 */
export class LnBolt11ZapPaymentProcessor implements PaymentProcessor {
  public readonly pmi = PMI_BITCOIN_LIGHTNING_BOLT11;

  // Defaults for the minimal constructor (lnAddress-only). These are public relays;
  // callers can override via options.relayUrls.
  private static readonly DEFAULT_RELAY_URLS = [
    'wss://relay.damus.io',
    'wss://relay.nostr.band',
    'wss://nos.lol',
  ];

  private readonly lnAddress: string;
  private readonly relayHandler: RelayHandler;
  private readonly relayUrls: string[];
  private readonly ttlSeconds: number;
  private readonly logger: Logger;

  private readonly signerSecretKey: Uint8Array;
  private readonly inFlightVerifications: LruCache<
    Promise<{ _meta?: Record<string, unknown> }>
  >;
  private readonly pendingInvoices: LruCache<PendingInvoiceMeta>;

  public constructor(options: LnBolt11ZapPaymentProcessorOptions) {
    this.lnAddress = options.lnAddress;
    this.relayUrls =
      options.relayUrls ??
      options.relayHandler?.getRelayUrls?.() ??
      LnBolt11ZapPaymentProcessor.DEFAULT_RELAY_URLS;
    this.relayHandler =
      options.relayHandler ?? new ApplesauceRelayPool([...this.relayUrls]);

    this.ttlSeconds = options.ttlSeconds ?? 300;
    this.logger = createLogger('payments/zap-processor');

    this.signerSecretKey = generateSecretKey();

    this.inFlightVerifications = new LruCache(
      options.maxInFlightVerifications ?? 5000,
    );
    this.pendingInvoices = new LruCache(options.maxPendingInvoices ?? 10000);
  }

  public async createPaymentRequired(
    params: PaymentProcessorCreateParams,
  ): Promise<{
    amount: number;
    pay_req: string;
    description?: string;
    pmi: string;
    ttl?: number;
    _meta?: Record<string, unknown>;
  }> {
    if (this.relayUrls.length === 0) {
      throw new Error(
        'LnBolt11ZapPaymentProcessor requires relayUrls or a relayHandler with getRelayUrls() for verification',
      );
    }

    const amountMsats = Math.round(params.amount * 1000);
    this.logger.debug('Creating zap invoice', {
      requestEventId: params.requestEventId,
      amountSats: params.amount,
    });

    const payParams = await fetchLnurlPayParams({ lnAddress: this.lnAddress });

    if (!payParams.allowsNostr || !payParams.nostrPubkey) {
      throw new Error('LNURL-pay endpoint does not support NIP-57 zaps');
    }

    if (
      typeof payParams.minSendable === 'number' &&
      amountMsats < payParams.minSendable
    ) {
      throw new Error(
        `Amount is below lnurl minimum: ${amountMsats}msat < ${payParams.minSendable}msat`,
      );
    }
    if (
      typeof payParams.maxSendable === 'number' &&
      amountMsats > payParams.maxSendable
    ) {
      throw new Error(
        `Amount is above lnurl maximum: ${amountMsats}msat > ${payParams.maxSendable}msat`,
      );
    }

    const zapRequest = finalizeEvent(
      createZapRequest({
        amountMsats,
        recipientPubkey: payParams.nostrPubkey,
        relays: this.relayUrls,
      }),
      this.signerSecretKey,
    );

    const { pr } = await requestZapInvoice({
      callback: payParams.callback,
      amountMsats,
      zapRequestJson: JSON.stringify(zapRequest),
    });

    const since = Math.floor(Date.now() / 1000) - 10;
    this.pendingInvoices.set(pr, {
      expectedZapperPubkey: payParams.nostrPubkey,
      since,
      amountMsats,
    });

    return {
      amount: params.amount,
      pay_req: pr,
      pmi: this.pmi,
      ttl: this.ttlSeconds,
      _meta: {
        rail: 'nip57',
      },
    };
  }

  public async verifyPayment(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    const existing = this.inFlightVerifications.get(params.pay_req);
    if (existing) return await existing;

    const run = this.verifyPaymentInternal(params).finally(() => {
      this.inFlightVerifications.delete(params.pay_req);
    });
    this.inFlightVerifications.set(params.pay_req, run);
    return await run;
  }

  private async verifyPaymentInternal(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    if (this.relayUrls.length === 0) {
      throw new Error(
        'LnBolt11ZapPaymentProcessor requires relayUrls or a relayHandler with getRelayUrls() for verification',
      );
    }

    const pending = this.pendingInvoices.get(params.pay_req);
    if (!pending) {
      // Stateless fallback: re-fetch pay params to get the expected zapper pubkey.
      const payParams = await fetchLnurlPayParams({
        lnAddress: this.lnAddress,
      });
      if (!payParams.nostrPubkey) {
        throw new Error('Cannot verify zap receipt: missing lnurl nostrPubkey');
      }
      this.pendingInvoices.set(params.pay_req, {
        expectedZapperPubkey: payParams.nostrPubkey,
        since: Math.floor(Date.now() / 1000) - this.ttlSeconds,
        amountMsats: NaN,
      });
    }

    const meta = this.pendingInvoices.get(params.pay_req);
    if (!meta) {
      throw new Error(
        'Cannot verify zap receipt: missing pending invoice metadata',
      );
    }

    const filter: Filter = {
      kinds: [kinds.Zap],
      authors: [meta.expectedZapperPubkey],
      since: meta.since,
    };

    this.logger.debug('Subscribing for zap receipts', {
      requestEventId: params.requestEventId,
      relayCount: this.relayUrls.length,
      expectedZapperPubkey: meta.expectedZapperPubkey,
      since: meta.since,
    });

    const receiptPromise = new Promise<NostrEvent>((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      let settled = false;

      const onAbort = () => {
        settled = true;
        cleanup();
        reject(new Error('verifyPayment aborted'));
      };

      const cleanup = () => {
        try {
          unsubscribe?.();
        } catch {
          // best-effort
        }
        unsubscribe = undefined;
        params.abortSignal?.removeEventListener('abort', onAbort);
      };

      params.abortSignal?.addEventListener('abort', onAbort, { once: true });

      void this.relayHandler
        .subscribe([filter], (event) => {
          try {
            const bolt11 = getBolt11FromZapReceipt(event);
            if (bolt11 !== params.pay_req) return;

            this.logger.info('Zap receipt matched invoice', {
              requestEventId: params.requestEventId,
              zapReceiptEventId: event.id,
            });
            settled = true;
            cleanup();
            resolve(event);
          } catch (error: unknown) {
            settled = true;
            cleanup();
            reject(error);
          }
        })
        .then((u) => {
          unsubscribe = u;
          if (settled) {
            // Event/abort/error may have fired before subscribe resolved.
            unsubscribe();
            unsubscribe = undefined;
          }
        })
        .catch((error: unknown) => {
          settled = true;
          cleanup();
          reject(error);
        });
    });

    const receipt = await receiptPromise;
    return { _meta: { zap_receipt_event_id: receipt.id } };
  }
}
