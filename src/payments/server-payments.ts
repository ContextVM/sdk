import { isJsonRpcRequest } from './types.js';
import type {
  CorrelatedNotificationSender,
  PaymentInteractionPolicy,
  PaymentProcessor,
  PricedCapability,
  ResolvePriceFn,
  ServerMiddlewareFn,
} from './types.js';
import type {
  PaymentStatePolicy,
  PaymentStateStore,
} from './payment-state-store.js';
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
  PaymentMethodUnavailableError,
  resolveAndInitiatePayment,
  verifyPaymentUnlessShutdown,
} from './server-payments-utils.js';
import {
  abandonServerPayment,
  serverPaymentAdmission,
  serverPaymentStore,
} from './server-payment-state.js';
import { validateServerPaymentOptions } from './server-payment-validation.js';

/** Server-side payment policy; both lifecycles share one atomic state store. */
export interface ServerPaymentsOptions extends Partial<PaymentStatePolicy> {
  processors: readonly PaymentProcessor[];
  pricedCapabilities: readonly PricedCapability[];
  /** Optional per-request quote, constrained by the advertised inclusive range. */
  resolvePrice?: ResolvePriceFn;
  /** Invoice creation/verification lease in milliseconds. @default 300_000 */
  paymentTtlMs?: number;
  /** Lifetime of a verified execution grant, measured from settlement. @default paymentTtlMs */
  authorizationTtlMs?: number;
  /** Application-owned atomic backend; defaults to process-local memory. The SDK does not initialize or close custom backends. */
  stateStore?: PaymentStateStore;
  /** Accepted interaction modes. @default 'optional' */
  paymentInteraction?: PaymentInteractionPolicy;
}

/**
 * Gates transparent requests using a retained event ledger. Verified event IDs
 * are admitted only within the store's replay window; invoice expiry never
 * releases their tombstones. Custom transports without event timestamps retain
 * their records indefinitely and fail closed when record capacity is reached.
 * Verified grants (including expired ones) and uncertain invoice creation are
 * retained for reconciliation. Expired known invoices can be replaced only by
 * a new admitted event; consumed rights never trigger automatic re-execution.
 */
export function createServerPaymentsMiddleware(params: {
  sender: CorrelatedNotificationSender;
  options: ServerPaymentsOptions;
  processorsByPmi?: Map<string, PaymentProcessor>;
  onInvoiceIssued?: (params: {
    requestEventId: string;
    snapshotTtlMs: number;
  }) => void;
  abortSignal?: AbortSignal;
}): ServerMiddlewareFn {
  const { sender, options, abortSignal } = params;
  validateServerPaymentOptions(options);
  const logger = createLogger('server-payments');
  const processorsByPmi =
    params.processorsByPmi ?? buildProcessorsByPmi(options.processors, logger);
  const store = serverPaymentStore(options);
  const leaseMs = options.paymentTtlMs ?? DEFAULT_PAYMENT_TTL_MS;
  const running = new Map<string, Promise<void>>();

  return async (message, ctx, forward) => {
    if (
      !isJsonRpcRequest(message) ||
      (ctx.paymentInteraction !== undefined &&
        ctx.paymentInteraction !== 'transparent')
    ) {
      await forward(message);
      return;
    }
    const priced = matchPricedCapability(message, options.pricedCapabilities);
    if (!priced || abortSignal?.aborted) {
      if (!priced) await forward(message);
      return;
    }
    const admission = serverPaymentAdmission(
      message,
      ctx,
      'transparent',
      leaseMs,
    );
    const existing = running.get(admission.key);
    if (existing) {
      await existing;
      return;
    }
    const reject = async (reason?: string): Promise<void> => {
      await sender.sendNotification(
        ctx.clientPubkey,
        {
          jsonrpc: '2.0',
          method: PAYMENT_REJECTED_METHOD,
          params: {
            pmi: options.processors[0]?.pmi ?? 'unspecified',
            amount: priced.amount,
            message: reason,
          },
        },
        admission.requestEventId,
      );
    };
    const work = (async (): Promise<void> => {
      const admitted = await store.admit(admission);
      if (admitted.status !== 'reserved') {
        if (admitted.status !== 'duplicate')
          await reject(`Payment admission refused: ${admitted.status}`);
        return;
      }
      const record = admitted.record;
      const fence = { key: record.key, generation: record.generation };
      try {
        if (abortSignal?.aborted) {
          await store.transition({ ...fence, type: 'release' });
          return;
        }
        const initiated = await resolveAndInitiatePayment({
          message,
          priced,
          requestEventId: admission.requestEventId,
          clientPubkey: ctx.clientPubkey,
          clientPmis: ctx.clientPmis,
          options,
          processorsByPmi,
          beforeInvoice: async () => {
            if (abortSignal?.aborted) return false;
            const owned = await store.transition({ ...fence, type: 'issuing' });
            return owned && !abortSignal?.aborted;
          },
        });
        if (initiated.kind === 'superseded') {
          await store.transition({ ...fence, type: 'release' });
          return;
        }
        if (initiated.kind === 'rejected') {
          if (await store.transition({ ...fence, type: 'reject' }))
            await reject(initiated.message);
          return;
        }
        if (initiated.kind === 'waived') {
          if (
            !abortSignal?.aborted &&
            (await store.transition({ ...fence, type: 'consume' }))
          ) {
            if (abortSignal?.aborted) return;
            await forward(message);
            await store.transition({ ...fence, type: 'dispatch' });
          }
          return;
        }
        const { paymentRequired, mergedMeta, processor, verifyTimeoutMs } =
          initiated;
        const pollingTimeoutMs = Math.min(verifyTimeoutMs, leaseMs);
        if (
          !(await store.transition({
            ...fence,
            type: 'bind',
            invoice: { ...paymentRequired, _meta: mergedMeta },
            leaseMs: pollingTimeoutMs,
          }))
        )
          return;
        if (abortSignal?.aborted) return;
        params.onInvoiceIssued?.({
          requestEventId: admission.requestEventId,
          snapshotTtlMs: leaseMs + 60_000,
        });
        if (abortSignal?.aborted) return;
        await sender.sendNotification(
          ctx.clientPubkey,
          {
            jsonrpc: '2.0',
            method: PAYMENT_REQUIRED_METHOD,
            params: { ...paymentRequired, _meta: mergedMeta },
          },
          admission.requestEventId,
        );
        const verified = await verifyPaymentUnlessShutdown({
          processor,
          verifyParams: {
            pay_req: paymentRequired.pay_req,
            requestEventId: admission.requestEventId,
            clientPubkey: ctx.clientPubkey,
          },
          timeoutMs: pollingTimeoutMs,
          shutdownSignal: abortSignal,
        });
        if (
          !verified ||
          abortSignal?.aborted ||
          !(await store.transition({ ...fence, type: 'consume' }))
        )
          return;
        if (abortSignal?.aborted) return;
        try {
          await sender.sendNotification(
            ctx.clientPubkey,
            {
              jsonrpc: '2.0',
              method: PAYMENT_ACCEPTED_METHOD,
              params: {
                amount: paymentRequired.amount,
                pmi: paymentRequired.pmi,
                _meta: verified._meta,
              },
            },
            admission.requestEventId,
          );
        } catch {
          logger.warn(
            'payment_accepted publication failed; execution right remains consumed',
            { requestEventId: admission.requestEventId },
          );
        }
        if (abortSignal?.aborted) return;
        await forward(message);
        await store.transition({ ...fence, type: 'dispatch' });
      } catch (error) {
        await abandonServerPayment(store, record);
        if (error instanceof PaymentMethodUnavailableError) {
          await reject(error.message);
          return;
        }
        throw error;
      }
    })();
    running.set(admission.key, work);
    try {
      await work;
    } finally {
      if (running.get(admission.key) === work) running.delete(admission.key);
    }
  };
}
