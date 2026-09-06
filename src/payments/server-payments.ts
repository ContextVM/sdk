import { isJsonRpcRequest } from './types.js';
import type {
  CorrelatedNotificationSender,
  PaymentAcceptedNotification,
  PaymentInteractionPolicy,
  PaymentProcessor,
  PaymentRejectedNotification,
  PaymentRequiredNotification,
  PricedCapability,
  ResolvePriceFn,
  ServerMiddlewareFn,
} from './types.js';
import { LruCache } from '../core/utils/lru-cache.js';
import { withTimeout } from '../core/utils/utils.js';
import { createLogger } from '../core/utils/logger.js';
import {
  DEFAULT_PAYMENT_TTL_MS,
  PAYMENT_ACCEPTED_METHOD,
  PAYMENT_REJECTED_METHOD,
  PAYMENT_REQUIRED_METHOD,
} from './constants.js';
import {
  buildProcessorsByPmi,
  matchPricedCapability,
  resolveAndInitiatePayment,
  resolvePaymentProcessor,
} from './server-payments-utils.js';

export interface ServerPaymentsOptions {
  processors: readonly PaymentProcessor[];
  pricedCapabilities: readonly PricedCapability[];

  /** Optional dynamic pricing callback used to compute a per-request quote. */
  resolvePrice?: ResolvePriceFn;
  /**
   * Maximum time to keep a request in pending-payment state.
   *
   * Note: if the payment request includes a CEP-8 `ttl` (seconds), the effective
   * verification timeout will be derived from that TTL. This option is primarily
   * a memory/DoS guardrail.
   *
   * @default 300_000
   */
  paymentTtlMs?: number;

  /**
   * Maximum number of concurrent pending-payment request ids to track.
   *
   * This is a DoS/memory-safety guardrail. Once reached, new priced requests
   * are refused (best-effort `payment_rejected`, no invoice minted) rather than
   * evicting a live entry — an evicted live payment loses its dedup and a
   * redelivery would mint a second invoice (CEP-8: MUST NOT charge twice).
   * `0` refuses all priced requests.
   *
   * @default 1000
   */
  maxPendingPayments?: number;

  /**
   * Server-side policy for which payment interaction lifecycles this server
   * accepts. `optional` mirrors the client's requested mode (the default);
   * `transparent` makes the server transparent-only.
   * @default 'optional'
   */
  paymentInteraction?: PaymentInteractionPolicy;
}

function purgeExpiredPending<T extends { expiresAtMs: number }>(params: {
  pending: LruCache<T>;
  nowMs: number;
  maxToCheck: number;
}): void {
  let checked = 0;
  for (const [key, value] of params.pending.entries()) {
    if (checked >= params.maxToCheck) {
      break;
    }
    checked += 1;
    if (value.expiresAtMs <= params.nowMs) {
      params.pending.delete(key);
    }
  }
}

type PendingPaymentState = {
  expiresAtMs: number;
  inFlight: Promise<void>;
};

/**
 * Extra lifetime granted to a transport route snapshot beyond the payment TTL,
 * so a settled response can still be routed after a slow handler finishes.
 */
const ROUTE_SNAPSHOT_GRACE_MS = 60_000;

function createPaymentRequiredNotification(params: {
  amount: number;
  pay_req: string;
  pmi: string;
  description?: string;
  ttl?: number;
  _meta?: Record<string, unknown>;
}): PaymentRequiredNotification {
  return {
    jsonrpc: '2.0',
    method: PAYMENT_REQUIRED_METHOD,
    params,
  };
}

function createPaymentAcceptedNotification(params: {
  amount: number;
  pmi: string;
  _meta?: Record<string, unknown>;
}): PaymentAcceptedNotification {
  return {
    jsonrpc: '2.0',
    method: PAYMENT_ACCEPTED_METHOD,
    params,
  };
}

function createPaymentRejectedNotification(params: {
  pmi: string;
  amount?: number;
  message?: string;
}): PaymentRejectedNotification {
  return {
    jsonrpc: '2.0',
    method: PAYMENT_REJECTED_METHOD,
    params,
  };
}

/**
 * Creates a server-side middleware that gates priced requests until payment is verified.
 */
export function createServerPaymentsMiddleware(params: {
  sender: CorrelatedNotificationSender;
  options: ServerPaymentsOptions;
  /** Pre-built PMI → processor map. Built locally when omitted (standalone use). */
  processorsByPmi?: Map<string, PaymentProcessor>;
  /**
   * Fired once an invoice has been issued for a request, before verification
   * begins. Lets the transport snapshot the correlation route/session a paid
   * response may need after its route is popped (duplicate-delivery cleanup)
   * or its idle session is LRU-evicted mid-payment (CEP-8).
   */
  onInvoiceIssued?: (params: {
    requestEventId: string;
    snapshotTtlMs: number;
  }) => void;
}): ServerMiddlewareFn {
  const { sender, options } = params;
  const logger = createLogger('server-payments');
  const processorsByPmi =
    params.processorsByPmi ?? buildProcessorsByPmi(options.processors, logger);

  // Non-positive TTLs would birth-expire every pending entry (disarming the
  // redelivery dedup while invoices stay payable); fall back to the default,
  // mirroring getVerificationTimeoutMs's guard.
  const paymentTtlMs =
    options.paymentTtlMs && options.paymentTtlMs > 0
      ? options.paymentTtlMs
      : DEFAULT_PAYMENT_TTL_MS;
  const maxPendingPayments = options.maxPendingPayments ?? 1000;
  const pending = new LruCache<PendingPaymentState>(
    Math.max(1, maxPendingPayments),
  );

  return async (message, ctx, forward) => {
    // Only gate requests. Never interfere with notifications.
    if (!isJsonRpcRequest(message)) {
      await forward(message);
      return;
    }

    if (
      ctx.paymentInteraction !== undefined &&
      ctx.paymentInteraction !== 'transparent'
    ) {
      await forward(message);
      return;
    }

    const priced = matchPricedCapability(message, options.pricedCapabilities);
    if (!priced) {
      await forward(message);
      return;
    }

    logger.debug('priced capability matched', {
      method: message.method,
      requestEventId: String(message.id),
      pricedMethod: priced.method,
      pricedName: priced.name,
    });

    const requestEventId = String(message.id);
    const now = Date.now();

    // Opportunistic cleanup so one-shot spam doesn't accumulate until reuse.
    purgeExpiredPending({ pending, nowMs: now, maxToCheck: 25 });

    const existing = pending.get(requestEventId);
    if (existing && existing.expiresAtMs > now) {
      // Duplicate request event id: await the in-flight work deterministically.
      // This avoids double-charge races and avoids black-holing duplicates.
      logger.debug('duplicate request event detected, awaiting in-flight', {
        requestEventId,
      });
      await existing.inFlight;
      return;
    }

    // Capacity guard, before any invoice is minted: silently evicting a live
    // entry here would disarm its dedup, and a redelivery of the evicted
    // request would be charged twice (CEP-8: MUST NOT charge twice).
    if (pending.size >= maxPendingPayments) {
      purgeExpiredPending({
        pending,
        nowMs: now,
        maxToCheck: Number.POSITIVE_INFINITY,
      });
    }
    if (pending.size >= maxPendingPayments) {
      logger.warn('pending payment capacity reached, refusing priced request', {
        requestEventId,
        method: message.method,
        maxPendingPayments,
      });
      // Refuse without charging: best-effort payment_rejected so the client
      // stops waiting instead of hanging until its own TTL.
      try {
        const processor = resolvePaymentProcessor(
          ctx.clientPmis,
          processorsByPmi,
          options.processors,
        );
        await sender.sendNotification(
          ctx.clientPubkey,
          createPaymentRejectedNotification({
            pmi: processor.pmi,
            amount: priced.amount,
            message: 'payment capacity reached, retry later',
          }),
          requestEventId,
        );
      } catch (err) {
        logger.warn('failed to send payment capacity rejection', {
          requestEventId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // IMPORTANT: set pending state synchronously before any await to make idempotency atomic.
    let invoiceIssued = false;
    const inFlight = (async (): Promise<void> => {
      const initResult = await resolveAndInitiatePayment({
        message,
        priced,
        requestEventId,
        clientPubkey: ctx.clientPubkey,
        clientPmis: ctx.clientPmis,
        options,
        processorsByPmi,
      });

      // Handle rejection: emit payment_rejected and do not forward.
      if (initResult.kind === 'rejected') {
        logger.info('payment rejected', {
          requestEventId,
          pmi: initResult.pmi,
          amount: priced.amount,
          reason: initResult.message,
        });

        const rejectedNotification = createPaymentRejectedNotification({
          pmi: initResult.pmi,
          amount: priced.amount,
          message: initResult.message,
        });

        await sender.sendNotification(
          ctx.clientPubkey,
          rejectedNotification,
          requestEventId,
        );
        return;
      }

      if (initResult.kind === 'waived') {
        logger.debug('payment waived, forwarding priced request', {
          requestEventId,
          method: message.method,
        });

        await forward(message);
        return;
      }

      const { paymentRequired, mergedMeta, processor, verifyTimeoutMs } =
        initResult;

      // An invoice now exists on the payment rail — from here on, every
      // outcome keeps the pending entry until TTL: the client's money may
      // already be gone, and a redelivery MUST NOT mint a second invoice.
      invoiceIssued = true;
      params.onInvoiceIssued?.({
        requestEventId,
        snapshotTtlMs: paymentTtlMs + ROUTE_SNAPSHOT_GRACE_MS,
      });

      const requiredNotification = createPaymentRequiredNotification({
        amount: paymentRequired.amount,
        pay_req: paymentRequired.pay_req,
        pmi: paymentRequired.pmi,
        description: paymentRequired.description,
        ttl: paymentRequired.ttl,
        _meta: mergedMeta,
      });

      logger.info('payment required notification sent', {
        requestEventId,
        pmi: paymentRequired.pmi,
        amount: paymentRequired.amount,
        ttl: paymentRequired.ttl,
      });

      await sender.sendNotification(
        ctx.clientPubkey,
        requiredNotification,
        requestEventId,
      );

      // Use the strict verification timeout bound for polling
      const pollingTimeoutMs = Math.min(verifyTimeoutMs, paymentTtlMs);

      logger.debug('verifying payment', {
        requestEventId,
        pmi: paymentRequired.pmi,
        timeoutMs: pollingTimeoutMs,
      });

      const controller = new AbortController();
      const verified = await withTimeout(
        processor.verifyPayment({
          pay_req: paymentRequired.pay_req,
          requestEventId,
          clientPubkey: ctx.clientPubkey,
          abortSignal: controller.signal,
        }),
        pollingTimeoutMs,
        'verifyPayment timed out',
      ).finally(() => controller.abort());

      logger.info('payment accepted', {
        requestEventId,
        pmi: paymentRequired.pmi,
        amount: paymentRequired.amount,
      });

      const acceptedNotification = createPaymentAcceptedNotification({
        amount: paymentRequired.amount,
        pmi: paymentRequired.pmi,
        _meta: verified._meta,
      });

      // payment_accepted is a SHOULD (CEP-8); the capability result is the
      // point. A publish failure here (relay error, or the idle paying
      // client's session LRU-evicted mid-payment) MUST NOT abort the forward —
      // that would be paid-but-undelivered. Do not turn this back into an
      // early return.
      try {
        await sender.sendNotification(
          ctx.clientPubkey,
          acceptedNotification,
          requestEventId,
        );
      } catch (err) {
        logger.warn('failed to publish payment_accepted, forwarding anyway', {
          requestEventId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.debug('forwarding priced request after payment', {
        requestEventId,
        method: message.method,
      });

      await forward(message);
    })();

    const state: PendingPaymentState = {
      expiresAtMs: now + paymentTtlMs,
      inFlight,
    };
    pending.set(requestEventId, state);

    try {
      await inFlight;
      // On success, keep the entry in `pending` until TTL expiry.
      // This guards against relay redelivery triggering a second charge.
      // purgeExpiredPending handles eventual cleanup.
    } catch (err) {
      // Pre-invoice failures never billed anyone — delete so the retry is free.
      // Post-invoice failures keep the entry until TTL for the same reason as
      // success: the client may already have paid, and a redelivery of the
      // same request event MUST NOT mint a second invoice (CEP-8).
      if (!invoiceIssued) {
        pending.delete(requestEventId);
      }
      throw err;
    }
  };
}
