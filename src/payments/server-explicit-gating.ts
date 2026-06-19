import type { JSONRPCErrorResponse } from '@contextvm/mcp-sdk/types.js';
import type { ServerMiddlewareFn } from './types.js';
import { isJsonRpcRequest } from './types.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import type { AuthorizationStore } from './authorization-store.js';
import { computeCanonicalInvocationIdentity } from './canonical-identity.js';
import {
  matchPricedCapability,
  resolveAndInitiatePayment,
} from './server-payments-utils.js';
import { createLogger } from '../core/utils/logger.js';
import { withTimeout } from '../core/utils/utils.js';
import {
  PAYMENT_PENDING_ERROR_CODE,
  PAYMENT_REQUIRED_ERROR_CODE,
} from './constants.js';

export interface ExplicitGatingMiddlewareParams {
  options: ServerPaymentsOptions;
  authorizationStore: AuthorizationStore;
  sendResponse: (
    clientPubkey: string,
    response: JSONRPCErrorResponse,
    requestEventId: string,
  ) => Promise<void>;
}

export function createExplicitGatingMiddleware(
  params: ExplicitGatingMiddlewareParams,
): ServerMiddlewareFn {
  const { options, authorizationStore, sendResponse } = params;
  const logger = createLogger('server-explicit-gating');

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

  const processorsByPmi = new Map(
    options.processors.map((p) => [p.pmi, p] as const),
  );

  return async (message, ctx, forward) => {
    // Only gate requests.
    if (!isJsonRpcRequest(message)) {
      await forward(message);
      return;
    }

    if (ctx.paymentInteraction !== 'explicit_gating') {
      await forward(message);
      return;
    }

    const priced = matchPricedCapability(message, options.pricedCapabilities);
    if (!priced) {
      await forward(message);
      return;
    }

    const requestEventId = String(message.id);
    const identity = computeCanonicalInvocationIdentity(
      ctx.clientPubkey,
      message.method,
      message.params,
    );

    // 1. Try to claim an existing authorization
    if (authorizationStore.claim(identity)) {
      logger.debug('authorization claimed, forwarding request', {
        requestEventId,
        method: message.method,
      });
      await forward(message);
      return;
    }

    const paymentTtlMs = options.paymentTtlMs ?? 300_000;

    // 2. Try to set pending state atomically
    // We use a safe default TTL here, but will override it below if the payment option has a specific TTL
    if (!authorizationStore.trySetPending(identity, paymentTtlMs)) {
      logger.debug('payment already pending, returning -32043', {
        requestEventId,
      });
      const errorResponse: JSONRPCErrorResponse = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: PAYMENT_PENDING_ERROR_CODE,
          message: 'Payment Pending',
          data: {
            instructions:
              'A payment is already pending for this invocation. Wait and retry.',
            // Suggest a short polling interval (e.g. 2 seconds) rather than the full TTL
            retry_after: Math.min(
              2,
              Math.max(
                1,
                Math.ceil(
                  authorizationStore.getPendingRemainingMs(identity) / 1000,
                ),
              ),
            ),
          },
        },
      };
      await sendResponse(ctx.clientPubkey, errorResponse, requestEventId);
      return;
    }

    // 3. Resolve price and initiate new payment
    try {
      const initResult = await resolveAndInitiatePayment({
        message,
        priced,
        requestEventId,
        clientPubkey: ctx.clientPubkey,
        clientPmis: ctx.clientPmis,
        options,
        processorsByPmi,
      });

      if (initResult.kind === 'rejected') {
        logger.info('payment rejected', {
          requestEventId,
          pmi: initResult.pmi,
          amount: priced.amount,
          reason: initResult.message,
        });

        authorizationStore.clearPending(identity);

        // Spec: When a capability is rejected by policy, return a standard error.
        // We'll use -32000 (Internal error or application-defined error) since CEP-8 doesn't specify a special rejection code.
        const errorResponse: JSONRPCErrorResponse = {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: initResult.message || 'Payment rejected by policy',
          },
        };
        await sendResponse(ctx.clientPubkey, errorResponse, requestEventId);
        return;
      }

      if (initResult.kind === 'waived') {
        logger.debug('payment waived, forwarding priced request', {
          requestEventId,
          method: message.method,
        });

        authorizationStore.clearPending(identity);
        await forward(message);
        return;
      }

      const { paymentRequired, mergedMeta, processor, verifyTimeoutMs } = initResult;

      // Use the strict verification timeout bound for polling
      const pollingTimeoutMs = Math.min(verifyTimeoutMs, paymentTtlMs);

      // Note: use the original payment request's TTL as the limit for the grant, not the verify timeout.
      // verifyTimeoutMs includes standard bounds, but for grants we want to honor the
      // payment option's TTL explicitly if it is smaller, or the fallback paymentTtlMs.
      const grantTtlMs =
        paymentRequired.ttl !== undefined
          ? paymentRequired.ttl * 1000
          : paymentTtlMs;

      // Update pending with the precise TTL
      authorizationStore.updatePendingTtl(identity, grantTtlMs);

      const errorResponse: JSONRPCErrorResponse = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: PAYMENT_REQUIRED_ERROR_CODE,
          message: 'Payment Required',
          data: {
            instructions:
              'Payment is required to process this request. Please pay one of the following options and retry the request.',
            payment_options: [
              {
                amount: paymentRequired.amount,
                pmi: paymentRequired.pmi,
                pay_req: paymentRequired.pay_req,
                description: paymentRequired.description,
                ttl: paymentRequired.ttl,
                _meta: mergedMeta,
              },
            ],
          },
        },
      };

      logger.info('payment required error sent', {
        requestEventId,
        pmi: paymentRequired.pmi,
        amount: paymentRequired.amount,
        ttl: paymentRequired.ttl,
      });

      await sendResponse(ctx.clientPubkey, errorResponse, requestEventId);

      // Start async verification
      // Do not await this, we must let the middleware chain return the error response.
      (async () => {
        const controller = new AbortController();
        try {
          logger.debug('verifying explicit payment', {
            requestEventId,
            pmi: paymentRequired.pmi,
            timeoutMs: pollingTimeoutMs,
          });

          await withTimeout(
            processor.verifyPayment({
              pay_req: paymentRequired.pay_req,
              requestEventId,
              clientPubkey: ctx.clientPubkey,
              abortSignal: controller.signal,
            }),
            pollingTimeoutMs,
            'verifyPayment timed out',
          );

          logger.info('explicit payment accepted, granting authorization', {
            requestEventId,
            pmi: paymentRequired.pmi,
            amount: paymentRequired.amount,
          });

          authorizationStore.grant(identity, grantTtlMs);
        } catch (err) {
          logger.info('explicit payment verification failed or timed out', {
            requestEventId,
            error: err instanceof Error ? err.message : String(err),
          });
          authorizationStore.clearPending(identity);
        } finally {
          controller.abort();
        }
      })().catch((err) => {
        logger.error('unhandled exception in async payment verification', {
          requestEventId,
          pmi: paymentRequired.pmi,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      authorizationStore.clearPending(identity);
      throw err;
    }
  };
}
