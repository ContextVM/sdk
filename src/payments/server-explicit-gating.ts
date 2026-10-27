import type { JSONRPCErrorResponse } from '@contextvm/mcp-sdk/types.js';
import type { ServerMiddlewareFn, PaymentProcessor } from './types.js';
import { isJsonRpcRequest } from './types.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import type { PaymentStateStore } from './payment-state-store.js';
import { paymentEventKey } from './payment-state-store.js';
import {
  buildProcessorsByPmi,
  matchPricedCapability,
  PaymentMethodUnavailableError,
  resolveAndInitiatePayment,
  verifyPaymentUnlessShutdown,
} from './server-payments-utils.js';
import { createLogger } from '../core/utils/logger.js';
import {
  DEFAULT_PAYMENT_TTL_MS,
  PAYMENT_CAPACITY_ERROR_CODE,
  PAYMENT_PENDING_ERROR_CODE,
  PAYMENT_REQUIRED_ERROR_CODE,
} from './constants.js';
import {
  abandonServerPayment,
  serverPaymentAdmission,
} from './server-payment-state.js';
import { validateServerPaymentOptions } from './server-payment-validation.js';

/** Explicit-gating dependencies; share this store with the transparent middleware. */
export interface ExplicitGatingMiddlewareParams {
  options: ServerPaymentsOptions;
  authorizationStore: PaymentStateStore;
  sendResponse: (
    clientPubkey: string,
    response: JSONRPCErrorResponse,
    requestEventId: string,
  ) => Promise<void>;
  processorsByPmi?: Map<string, PaymentProcessor>;
  abortSignal?: AbortSignal;
}

/** Atomically claims one paid execution or reserves a generation-fenced invoice. */
export function createExplicitGatingMiddleware(
  params: ExplicitGatingMiddlewareParams,
): ServerMiddlewareFn {
  const {
    options,
    authorizationStore: store,
    sendResponse,
    abortSignal,
  } = params;
  validateServerPaymentOptions({ ...options, stateStore: store });
  const logger = createLogger('server-explicit-gating');
  const processorsByPmi =
    params.processorsByPmi ?? buildProcessorsByPmi(options.processors, logger);
  const leaseMs = options.paymentTtlMs ?? DEFAULT_PAYMENT_TTL_MS;

  return async (message, ctx, forward) => {
    if (
      !isJsonRpcRequest(message) ||
      ctx.paymentInteraction !== 'explicit_gating'
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
      'explicit_gating',
      leaseMs,
    );
    const respond = async (
      code: number,
      text: string,
      data?: Record<string, unknown>,
    ): Promise<void> => {
      await sendResponse(
        ctx.clientPubkey,
        {
          jsonrpc: '2.0',
          id: message.id,
          error: { code, message: text, ...(data && { data }) },
        },
        admission.requestEventId,
      );
    };
    const admitted = await store.admit(admission);
    if (admitted.status === 'claimed') {
      if (!abortSignal?.aborted) {
        await forward(message);
        await store.transition({
          key: admitted.record.key,
          generation: admitted.record.generation,
          type: 'dispatch',
        });
      }
      return;
    }
    if (admitted.status === 'duplicate') return;
    if (admitted.status === 'pending') {
      await respond(PAYMENT_PENDING_ERROR_CODE, 'Payment Pending', {
        retry_after: 2,
      });
      return;
    }
    if (admitted.status !== 'reserved') {
      await respond(
        PAYMENT_CAPACITY_ERROR_CODE,
        admitted.status === 'capacity'
          ? 'Payment capacity reached, retry later'
          : admitted.status === 'expired'
            ? 'Paid authorization expired; contact the server operator to reconcile the payment before paying again'
            : `Payment admission refused: ${admitted.status}`,
        { reason: `payment_${admitted.status}` },
      );
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
        if (await store.transition({ ...fence, type: 'release' }))
          await respond(
            -32000,
            initiated.message ?? 'Payment rejected by policy',
          );
        return;
      }
      if (initiated.kind === 'waived') {
        if (
          !abortSignal?.aborted &&
          (await store.transition({ ...fence, type: 'consume' }))
        ) {
          if (abortSignal?.aborted) return;
          await forward(message);
          await store.transition({
            ...fence,
            key: paymentEventKey(ctx.clientPubkey, admission.requestEventId),
            type: 'dispatch',
          });
        }
        return;
      }
      const { paymentRequired, mergedMeta, processor, verifyTimeoutMs } =
        initiated;
      const timeoutMs = Math.min(verifyTimeoutMs, leaseMs);
      if (
        !(await store.transition({
          ...fence,
          type: 'bind',
          invoice: { ...paymentRequired, _meta: mergedMeta },
          leaseMs: timeoutMs,
        }))
      )
        return;
      if (abortSignal?.aborted) return;
      await respond(PAYMENT_REQUIRED_ERROR_CODE, 'Payment Required', {
        instructions:
          'Pay one option, then retry with the same method and semantic params.',
        payment_options: [{ ...paymentRequired, _meta: mergedMeta }],
      });
      void (async (): Promise<void> => {
        const verified = await verifyPaymentUnlessShutdown({
          processor,
          verifyParams: {
            pay_req: paymentRequired.pay_req,
            requestEventId: admission.requestEventId,
            clientPubkey: ctx.clientPubkey,
          },
          timeoutMs,
          shutdownSignal: abortSignal,
        });
        if (!verified || abortSignal?.aborted) {
          await store.transition({ ...fence, type: 'expire' });
          return;
        }
        await store.transition({
          ...fence,
          type: 'grant',
          ttlMs: options.authorizationTtlMs ?? leaseMs,
        });
      })().catch(async () => {
        try {
          await store.transition({ ...fence, type: 'expire' });
        } catch {
          logger.error('Payment verification state could not be persisted', {
            requestEventId: admission.requestEventId,
          });
        }
      });
    } catch (error) {
      await abandonServerPayment(store, record);
      if (error instanceof PaymentMethodUnavailableError) {
        await respond(-32000, error.message);
        return;
      }
      throw error;
    }
  };
}
