import type { JSONRPCErrorResponse } from '@modelcontextprotocol/sdk/types.js';
import type { ServerMiddlewareFn } from './types.js';
import { isJsonRpcRequest } from './types.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import type { AuthorizationStore } from './authorization-store.js';
import { computeCanonicalInvocationIdentity } from './canonical-identity.js';
import {
  getVerificationTimeoutMs,
  matchPricedCapability,
  isResolvePriceRejection,
  isResolvePriceWaiver,
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

  const processorsByPmi = new Map(
    options.processors.map((p) => [p.pmi, p] as const),
  );

  return async (message, ctx, forward) => {
    // Only gate requests.
    if (!isJsonRpcRequest(message)) {
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
            instructions: 'A payment is already pending for this invocation. Wait and retry.',
            retry_after: Math.ceil(authorizationStore.getPendingRemainingMs(identity) / 1000) || 5,
          },
        },
      };
      await sendResponse(ctx.clientPubkey, errorResponse, requestEventId);
      return;
    }

    // 3. Resolve price and initiate new payment
    try {
      const clientPmis = ctx.clientPmis;
      const chosenPmi = clientPmis
        ? clientPmis.find((pmi) => processorsByPmi.has(pmi))
        : undefined;

      const chosenProcessor = chosenPmi
        ? processorsByPmi.get(chosenPmi)
        : options.processors[0];

      if (!chosenProcessor) {
        throw new Error('No payment processors configured');
      }

      const processor = chosenProcessor;

      const quote = options.resolvePrice
        ? await options.resolvePrice({
            capability: priced,
            request: message,
            clientPubkey: ctx.clientPubkey,
            requestEventId,
          })
        : { amount: priced.amount, description: priced.description };

      if (isResolvePriceRejection(quote)) {
        logger.info('payment rejected', {
          requestEventId,
          pmi: processor.pmi,
          amount: priced.amount,
          reason: quote.message,
        });

        authorizationStore.clearPending(identity);
        
        // Spec: When a capability is rejected by policy, return a standard error.
        // We'll use -32000 (Internal error or application-defined error) since CEP-8 doesn't specify a special rejection code.
        const errorResponse: JSONRPCErrorResponse = {
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32000,
            message: quote.message || 'Payment rejected by policy',
          },
        };
        await sendResponse(ctx.clientPubkey, errorResponse, requestEventId);
        return;
      }

      if (isResolvePriceWaiver(quote)) {
        logger.debug('payment waived, forwarding priced request', {
          requestEventId,
          method: message.method,
        });

        authorizationStore.clearPending(identity);
        await forward(message);
        return;
      }

      const resolvedQuote = quote;
      const paymentRequired = await processor.createPaymentRequired({
        amount: resolvedQuote.amount,
        description: resolvedQuote.description,
        requestEventId,
        clientPubkey: ctx.clientPubkey,
      });

      const mergedMeta =
        resolvedQuote.meta === undefined &&
        paymentRequired._meta === undefined
          ? undefined
          : {
              ...(paymentRequired._meta ?? {}),
              ...(resolvedQuote.meta ?? {}),
            };

      // Ensure pending TTL matches the payment request TTL
      const verifyTimeoutMs = getVerificationTimeoutMs({
        ttlSeconds: paymentRequired.ttl,
      });
      const effectiveTimeoutMs = Math.min(verifyTimeoutMs, paymentTtlMs);
      
      // Note: Pending TTL was set to paymentTtlMs at line 74, which is >= effectiveTimeoutMs
      // This ensures pending state covers the entire verification period.

      const errorResponse: JSONRPCErrorResponse = {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: PAYMENT_REQUIRED_ERROR_CODE,
          message: 'Payment Required',
          data: {
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
            timeoutMs: effectiveTimeoutMs,
          });

          await withTimeout(
            processor.verifyPayment({
              pay_req: paymentRequired.pay_req,
              requestEventId,
              clientPubkey: ctx.clientPubkey,
              abortSignal: controller.signal,
            }),
            effectiveTimeoutMs,
            'verifyPayment timed out',
          );

          logger.info('explicit payment accepted, granting authorization', {
            requestEventId,
            pmi: paymentRequired.pmi,
            amount: paymentRequired.amount,
          });

          authorizationStore.grant(identity, effectiveTimeoutMs);
        } catch (err) {
          logger.info('explicit payment verification failed or timed out', {
            requestEventId,
            error: err instanceof Error ? err.message : String(err),
          });
          authorizationStore.clearPending(identity);
        } finally {
          controller.abort();
        }
      })();
    } catch (err) {
      authorizationStore.clearPending(identity);
      throw err;
    }
  };
}
