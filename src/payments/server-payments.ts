import { isJsonRpcRequest } from './types.js';
import type {
  CorrelatedNotificationSender,
  PaymentAcceptedNotification,
  PaymentProcessor,
  PaymentRejectedNotification,
  PaymentRequiredNotification,
  PricedCapability,
  ResolvePriceFn,
  ServerMiddlewareFn,
  PaymentInteractionMode,
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
  matchPricedCapability,
  resolveAndInitiatePayment,
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
   * This is a DoS/memory-safety guardrail.
   * @default 1000
   */
  maxPendingPayments?: number;

  /** Effective payment interaction mode for this server instance. @default 'transparent' */
  paymentInteraction?: PaymentInteractionMode;
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
}): ServerMiddlewareFn {
  const { sender, options } = params;
  const logger = createLogger('server-payments');
  const processorsByPmi = new Map(
    options.processors.map((p) => [p.pmi, p] as const),
  );

  // Warn on duplicate PMI processors — Map construction silently keeps only the last.
  const seenProcessorPmis = new Set<string>();
  for (const p of options.processors) {
    if (seenProcessorPmis.has(p.pmi)) {
      logger.warn('duplicate PMI processor registered, last one wins', {
        pmi: p.pmi,
      });
    }
    seenProcessorPmis.add(p.pmi);
  }

  const paymentTtlMs = options.paymentTtlMs ?? DEFAULT_PAYMENT_TTL_MS;
  const pending = new LruCache<PendingPaymentState>(
    options.maxPendingPayments ?? 1000,
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

    // IMPORTANT: set pending state synchronously before any await to make idempotency atomic.
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

      const { paymentRequired, mergedMeta, processor, verifyTimeoutMs } = initResult;

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

        await sender.sendNotification(
          ctx.clientPubkey,
          acceptedNotification,
          requestEventId,
        );

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
      // On failure, remove immediately so the client can retry.
      pending.delete(requestEventId);
      throw err;
    }
  };
}
