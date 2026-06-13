import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import {
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  JSONRPCNotification,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import {
  PaymentHandler,
  PaymentRejectedNotification,
  PaymentRequiredNotification,
  PaymentHandlerRequest,
} from './types.js';
import { createLogger } from '../core/utils/logger.js';
import type { OriginalRequestContext } from '../transport/nostr-client/correlation-store.js';
import {
  DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS,
  DEFAULT_PAYMENT_TTL_MS,
  PAYMENT_ACCEPTED_METHOD,
  PAYMENT_REJECTED_METHOD,
  PAYMENT_REQUIRED_METHOD,
  PAYMENT_REQUIRED_ERROR_CODE,
  PAYMENT_PENDING_ERROR_CODE,
} from './constants.js';

export interface ClientPaymentsOptions {
  handlers: readonly PaymentHandler[];
  /**
   * Interval for periodic synthetic progress heartbeats (milliseconds).
   *
   * One heartbeat is also emitted immediately when `payment_required` is
   * received so the MCP timeout is always reset as soon as the payment flow
   * begins.
   * @default DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS (30_000 ms)
   */
  syntheticProgressIntervalMs?: number;
  /**
   * Duration in ms for synthetic progress when `payment_required` carries no `ttl`.
   *
   * Mirrors the server-side `paymentTtlMs` default so the client keeps the MCP
   * request alive for at least as long as the server will wait.
   * @default DEFAULT_PAYMENT_TTL_MS (300_000 ms)
   */
  defaultPaymentTtlMs?: number;

  /**
   * Optional policy hook invoked when a `payment_required` notification is received.
   *
   * This is evaluated before checking rail-specific `canHandle` methods.
   *
   * When the underlying transport supports request correlation (e.g. {@link NostrClientTransport}),
   * `originalRequestContext` provides minimal details about the original JSON-RPC request that
   * triggered the payment.
   */
  paymentPolicy?: (
    req: PaymentHandlerRequest,
    originalRequestContext?: OriginalRequestContext,
  ) => boolean | Promise<boolean>;

  /** Requested payment interaction mode. @default 'transparent' */
  paymentInteraction?: import('./types.js').PaymentInteractionMode;

  /**
   * Handler for explicit-gating -32042 errors.
   * Called when a priced invocation returns Payment Required.
   * The handler should pay one option and signal completion.
   *
   * **Error handling contract**:
   * - If the promise resolves with `{ paid: true }`, the wrapper auto-retries the
   *   original request with the same `method` and `params`.
   * - If the promise resolves with `{ paid: false, reason }`, the wrapper synthesizes
   *   a JSON-RPC error to the caller with code `-32042` and `data: { reason }`.
   *   Use `reason: 'user_cancelled'` for user-initiated cancellations.
   * - If the promise **rejects**, the wrapper MUST NOT silently fall back.
   *   It synthesizes a JSON-RPC error with code `-32042` and
   *   `data: { reason: error.message, type: 'payment_handler_error' }`.
   * - Transient payment-provider failures should reject with an Error whose
   *   `message` contains the provider error details.
   */
  onPaymentRequired?: (params: {
    options: import('./types.js').PaymentOption[];
    instructions?: string;
    originalRequest: import('@modelcontextprotocol/sdk/types.js').JSONRPCRequest;
  }) => Promise<{ paid: boolean; reason?: string }>;
}

type ProgressToken = string;

type SyntheticProgressEntry = {
  stopAtMs: number;
  wireProgressToken: string | number;
};

type TransportWithContext = Transport & {
  onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { eventId: string; correlatedEventId?: string },
  ) => void;
};

function supportsOnmessageWithContext(
  transport: Transport,
): transport is TransportWithContext {
  // Avoid using the `in` operator here; prefer an ES3-compatible check.
  return Object.prototype.hasOwnProperty.call(
    transport,
    'onmessageWithContext',
  );
}

function isExplicitPaymentRequiredError(
  msg: JSONRPCMessage,
): msg is import('@modelcontextprotocol/sdk/types.js').JSONRPCErrorResponse {
  return (
    isJSONRPCErrorResponse(msg) &&
    msg.error.code === PAYMENT_REQUIRED_ERROR_CODE &&
    typeof msg.error.data === 'object' &&
    msg.error.data !== null &&
    Array.isArray((msg.error.data as { payment_options?: unknown }).payment_options) &&
    ((msg.error.data as { payment_options: unknown[] }).payment_options).length > 0
  );
}

function isExplicitPaymentPendingError(
  msg: JSONRPCMessage,
): msg is import('@modelcontextprotocol/sdk/types.js').JSONRPCErrorResponse {
  return (
    isJSONRPCErrorResponse(msg) &&
    msg.error.code === PAYMENT_PENDING_ERROR_CODE &&
    typeof msg.error.data === 'object' &&
    msg.error.data !== null &&
    typeof (msg.error.data as { retry_after?: unknown }).retry_after === 'number'
  );
}

function isPaymentRequiredNotification(
  msg: JSONRPCMessage,
): msg is PaymentRequiredNotification {
  return isJSONRPCNotification(msg) && msg.method === PAYMENT_REQUIRED_METHOD;
}

/**
 * Wraps a transport to automatically handle CEP-8 payment requests.
 *
 * When `transport` is a {@link NostrClientTransport}, PMI advertisement and
 * synthetic progress injection are enabled automatically.
 *
 * Note: `payment_rejected` → JSON-RPC error synthesis requires a
 * {@link NostrClientTransport} because correlation (requestEventId → MCP request id)
 * depends on Nostr event tagging. On plain transports a rejected payment surfaces
 * as an unhandled notification and the MCP request times out naturally.
 */
export function withClientPayments(
  transport: Transport,
  options: ClientPaymentsOptions,
): Transport {
  const logger = createLogger('client-payments');

  const syntheticProgressIntervalMs =
    options.syntheticProgressIntervalMs ??
    DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS;

  const defaultPaymentTtlMs =
    options.defaultPaymentTtlMs ?? DEFAULT_PAYMENT_TTL_MS;

  const syntheticProgress = new Map<ProgressToken, SyntheticProgressEntry>();

  let syntheticProgressScheduler: ReturnType<typeof setInterval> | undefined;

  const maybeStopScheduler = (): void => {
    if (syntheticProgress.size > 0) return;
    if (!syntheticProgressScheduler) return;
    clearInterval(syntheticProgressScheduler);
    syntheticProgressScheduler = undefined;
  };

  const tickSyntheticProgress = (): void => {
    if (syntheticProgress.size === 0) {
      maybeStopScheduler();
      return;
    }

    const now = Date.now();
    for (const [token, entry] of syntheticProgress) {
      if (now >= entry.stopAtMs) {
        syntheticProgress.delete(token);
        continue;
      }

      onmessage?.({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: entry.wireProgressToken,
          progress: 0,
        },
      } as JSONRPCNotification);
    }

    maybeStopScheduler();
  };

  const ensureSchedulerStarted = (): void => {
    if (syntheticProgressScheduler) return;
    syntheticProgressScheduler = setInterval(
      tickSyntheticProgress,
      syntheticProgressIntervalMs,
    );
  };

  const stopSyntheticProgress = (token: ProgressToken): void => {
    if (!syntheticProgress.delete(token)) return;
    maybeStopScheduler();
  };

  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const retryCounts = new Map<string | number, number>();
  const rawRequestCache = new Map<string | number, JSONRPCRequest>();
  const MAX_RETRIES = 5;

  const stopAllSyntheticProgress = (): void => {
    syntheticProgress.clear();
    if (syntheticProgressScheduler) {
      clearInterval(syntheticProgressScheduler);
      syntheticProgressScheduler = undefined;
    }
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    retryCounts.clear();
    rawRequestCache.clear();
  };

  // Ensure CEP-8 discovery/negotiation: when using Nostr transports, always advertise
  // supported PMIs derived from the handler list (preference order = handler order).
  if (transport instanceof NostrClientTransport) {
    transport.setClientPmis(options.handlers.map((h) => h.pmi));
    logger.debug('advertised client PMIs', {
      pmis: options.handlers.map((h) => h.pmi),
    });
    if (options.paymentInteraction === 'explicit_gating') {
      transport.setPaymentInteraction('explicit_gating');
      logger.debug('advertised requested payment interaction mode', {
        mode: 'explicit_gating',
      });
    }
  }

  const handlersByPmi = new Map(
    options.handlers.map((h) => [h.pmi, h] as const),
  );

  // Warn on duplicate PMI handlers — Map construction silently keeps only the last.
  const seenHandlerPmis = new Set<string>();
  for (const h of options.handlers) {
    if (seenHandlerPmis.has(h.pmi)) {
      logger.warn('duplicate PMI handler registered, last one wins', {
        pmi: h.pmi,
      });
    }
    seenHandlerPmis.add(h.pmi);
  }

  // Prevent double-paying if relays or servers deliver duplicate payment_required notifications.
  const inFlightPayReqs = new Set<string>();

  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  let onerror: ((error: Error) => void) | undefined;
  let onclose: (() => void) | undefined;

  async function maybeHandlePaymentRequired(
    message: JSONRPCMessage,
    requestEventId: string,
  ): Promise<void> {
    if (isExplicitPaymentRequiredError(message)) {
      // Explicit gating lifecycle (-32042 Payment Required)
      const data = message.error.data as import('./types.js').PaymentRequiredErrorData;
      
      for (const option of data.payment_options) {
        const handler = handlersByPmi.get(option.pmi);
        if (!handler && !options.onPaymentRequired) continue;

        // Note: For explicit gating errors (JSON-RPC error responses), the transport's
        // correlation store has already consumed the pending entry via resolveResponse().
        // We rely on rawRequestCache for the retry rather than the correlation store.

        const request: PaymentHandlerRequest = {
          amount: option.amount,
          pay_req: option.pay_req,
          pmi: option.pmi,
          description: option.description,
          ttl: option.ttl,
          _meta: option._meta,
          requestEventId,
        };

        const allow = options.paymentPolicy
          ? await options.paymentPolicy(request)
          : true;

        if (!allow) {
          logger.debug('payment_required rejected by policy', {
            requestEventId,
            pmi: option.pmi,
          });
          continue; // Try next option if rejected by policy
        }

        const canHandle = handler?.canHandle
          ? await handler.canHandle(request)
          : true;

        if (!canHandle) {
          logger.debug('payment_required cannot be handled by handler', {
            requestEventId,
            pmi: option.pmi,
          });
          continue; // Try next option if handler can't handle
        }

        logger.info('executing payment handler for explicit gating', {
          requestEventId,
          pmi: option.pmi,
          amount: option.amount,
        });

        try {
          // In explicit gating, we do NOT call handler.handle(request) directly.
          // Instead, we delegate entirely to options.onPaymentRequired.

          // In explicit gating, the client MUST retry the exact same request
          // to trigger authorization consumption and get the result.
          // Since we intercepted the error, we need the original request.
          // For NostrClientTransport, we don't have the original raw request cached perfectly, 
          // but we can reconstruct it or we should just let the error propagate 
          // and let the caller handle retry.
          
          if (!options.onPaymentRequired) {
            // We have a payment required error but the transport level onPaymentRequired handler
            // wasn't configured. The client didn't supply an explicit gating handler. 
            // We'll let the error propagate.
            onmessage?.(message);
            return;
          }
          
          const requestId = message.id;
          const rawRequest = requestId != null ? rawRequestCache.get(requestId) : undefined;
          if (!rawRequest) {
            logger.warn('missing raw original request, cannot retry explicit payment', { requestEventId });
            onmessage?.(message);
            return;
          }

          const result = await options.onPaymentRequired({
            options: data.payment_options,
            instructions: data.instructions,
            originalRequest: rawRequest,
          });
          
            if (result.paid) {
              // Only if they successfully paid via onPaymentRequired do we proceed to retry
              logger.info('explicit payment satisfied, retrying original request', {
                requestEventId,
                method: rawRequest.method,
              });
              
              // Re-send the exact request, updating the ID if necessary (or letting MCP SDK handle it)
              // But actually we are the transport, we can just resend the raw request through the transport.
            // Wait, we need to create a new ID so the proxy can track it properly.
            // Oh right, we can't easily resend and magically stitch it back to the original Promise in the MCP Client.
            // Actually, if we just send() it, the original promise in the MCP Client is already waiting 
            // for the response with the *original* ID.
            // Wait, no, the server sent us an error response with the *original* ID. 
            // The MCP Client will resolve that promise with an Error.
            // So we MUST NOT deliver the error response to `onmessage` if we want to intercept and retry.
            // We intercepted the error! We haven't called `onmessage` yet.
            // So if we just resend the raw request to the server, with a new requestEventId,
            // we will need to map the NEW response back to the OLD request ID.
            
            // This requires transport level support. 
            // The plan says: "When onPaymentRequired returns { paid: true }, the wrapper re-sends the original JSONRPCRequest with the same method and params (new id is fine per spec). This is transparent to the upstream MCP Client."
            // Wait, if it has a new id, how does the upstream MCP Client know it's the response?
            // Actually, we must use the original ID when communicating with the upstream client.
            // But when we send it to the server, we just pass the original request exactly as it was.
            // We don't change the ID. The `NostrClientTransport` wraps the `id` inside a new `requestId`.
            
            await transport.send(rawRequest);
            return; // WE SUCCESSFULLY RETRIED! Do not deliver the error to `onmessage`.
          } else {
            // User cancelled or returned paid=false
            logger.debug('onPaymentRequired returned paid=false', { requestEventId, reason: result.reason });
            const errorMsg: import('@modelcontextprotocol/sdk/types.js').JSONRPCMessage = {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: PAYMENT_REQUIRED_ERROR_CODE,
                message: 'Payment Required',
                data: { reason: result.reason || 'user_cancelled' }
              }
            };
            onmessage?.(errorMsg);
            return;
          }
        } catch (err) {
          logger.error('payment handler failed', {
            requestEventId,
            pmi: option.pmi,
            error: err instanceof Error ? err.message : String(err),
          });
          // Spec: onPaymentRequired rejection MUST cause the original JSON-RPC request to fail.
          const errorMsg: import('@modelcontextprotocol/sdk/types.js').JSONRPCMessage = {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: PAYMENT_REQUIRED_ERROR_CODE,
              message: 'Payment Required',
              data: { reason: err instanceof Error ? err.message : String(err), type: 'payment_handler_error' }
            }
          };
          onmessage?.(errorMsg);
          return;
        }

        // We handled (or attempted) the payment. Stop evaluating other options.
        // If we failed, we break and the -32042 will be emitted to `onmessage`.
        // Actually we already returned if we handled it.
      }
      
      // If we got here, we either:
      // 1. Paid successfully but we need to signal the caller to retry (if we don't retry ourselves)
      // 2. Failed to pay (policy, unhandled, or error)
      // In both cases, for now we will just emit the -32042 error to `onmessage` and let 
      // the caller retry. To implement transparent retry at the transport level, we'd need
      // to cache every outbound request, which is expensive.
      onmessage?.(message);
      return;
    }

    if (isExplicitPaymentPendingError(message)) {
      const data = message.error.data as import('./types.js').PaymentPendingErrorData;
      const retryAfterSeconds = data.retry_after;
      
      // Note: For explicit gating errors (JSON-RPC error responses), the transport's
      // correlation store has already consumed the pending entry via resolveResponse().
      // We rely on rawRequestCache for the retry rather than the correlation store.
      
      const requestId = message.id;
      const rawRequest = requestId != null ? rawRequestCache.get(requestId) : undefined;
      if (!rawRequest) {
        logger.warn('missing raw original request, cannot retry explicit payment pending', { requestEventId });
        onmessage?.(message);
        return;
      }
      
      const requestIdKey = message.id as string | number;
      const retries = retryCounts.get(requestIdKey) ?? 0;
      if (retries >= MAX_RETRIES) {
        logger.error('max explicit payment retries exceeded', { requestEventId, id: requestIdKey, maxRetries: MAX_RETRIES });
        onmessage?.(message);
        return;
      }

      retryCounts.set(requestIdKey, retries + 1);
      
      logger.info('payment pending, retrying after backoff', {
        requestEventId,
        retryAfterSeconds,
        retryCount: retries + 1,
      });
      
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        transport.send(rawRequest).catch(err => {
          logger.error('failed to retry pending request', { requestEventId, error: err instanceof Error ? err.message : String(err) });
        });
      }, (retryAfterSeconds ?? 1) * 1000);
      pendingTimers.add(timer);
      
      return; // Intercept the error so the client waits
    }

    if (!isPaymentRequiredNotification(message)) {
      return;
    }

    const handler = handlersByPmi.get(message.params.pmi);
    if (!handler) {
      logger.debug('no handler for PMI, ignoring payment_required', {
        pmi: message.params.pmi,
        requestEventId,
      });
      return;
    }

    const isNostrTransport = transport instanceof NostrClientTransport;

    const pending = isNostrTransport
      ? transport.getPendingRequestForEventId(requestEventId)
      : undefined;

    if (isNostrTransport && !pending) {
      logger.warn('dropping uncorrelated payment_required notification', {
        requestEventId,
        pmi: message.params.pmi,
        amount: message.params.amount,
      });
      return;
    }

    // If the transport can provide the original request's progressToken, emit synthetic
    // progress notifications locally to keep the upstream MCP request alive while the
    // payment settles (CEP-8 TTL can exceed the default MCP timeout).
    if (isNostrTransport) {
      const token = pending?.progressToken;
      // Fall back to defaultPaymentTtlMs when the server omits ttl so the client
      // keeps the MCP request alive for the same duration the server will wait.
      const ttlSeconds =
        message.params.ttl !== undefined
          ? message.params.ttl
          : defaultPaymentTtlMs / 1000;
      if (token && Number.isFinite(ttlSeconds)) {
        // Guard against nonsensical TTLs.
        const ttlMs = Math.floor(ttlSeconds * 1000);
        if (ttlMs > 0 && !syntheticProgress.has(token)) {
          const stopAtMs = Date.now() + ttlMs;

          const wireProgressToken = Number.isFinite(Number(token))
            ? Number(token)
            : token;
          syntheticProgress.set(token, {
            stopAtMs,
            wireProgressToken,
          });
          ensureSchedulerStarted();

          // Reset the MCP timeout immediately — don't wait for the interval tick
          onmessage?.({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: {
              progressToken: wireProgressToken,
              progress: 0,
            },
          } as JSONRPCNotification);

          logger.debug('started synthetic progress', {
            requestEventId,
            progressToken: token,
            ttlSeconds,
            intervalMs: syntheticProgressIntervalMs,
          });
        }
      }
    }

    // Best-effort client-side dedupe keyed by pay_req.
    // IMPORTANT: claim synchronously before any await to avoid double-pay races.
    if (inFlightPayReqs.has(message.params.pay_req)) {
      logger.debug('duplicate pay_req detected, skipping', {
        payReq: message.params.pay_req.substring(0, 20) + '...',
        requestEventId,
      });
      return;
    }

    inFlightPayReqs.add(message.params.pay_req);
    try {
      const req: PaymentHandlerRequest = {
        amount: message.params.amount,
        pay_req: message.params.pay_req,
        pmi: message.params.pmi,
        description: message.params.description,
        ttl: message.params.ttl,
        _meta: message.params._meta,
        requestEventId,
      };

      const synthesizeClientDeclineError = (params: {
        message: string;
      }): void => {
        if (pending?.originalRequestId == null) {
          return;
        }

        if (pending.progressToken) {
          stopSyntheticProgress(pending.progressToken);
        }

        onmessage?.({
          jsonrpc: '2.0',
          id: pending.originalRequestId,
          error: {
            code: -32000,
            message: params.message,
            data: {
              pmi: req.pmi,
              amount: req.amount,
              method: pending.originalRequestContext?.method,
              capability: pending.originalRequestContext?.capability,
            },
          },
        } as JSONRPCMessage);
      };

      logger.info('processing payment_required', {
        requestEventId,
        pmi: message.params.pmi,
        amount: message.params.amount,
      });

      if (options.paymentPolicy) {
        const isApproved = await options.paymentPolicy(
          req,
          pending?.originalRequestContext,
        );
        if (!isApproved) {
          logger.debug('paymentPolicy declined the payment', {
            requestEventId,
            pmi: message.params.pmi,
            amount: message.params.amount,
          });
          synthesizeClientDeclineError({
            message: 'Payment declined by client policy',
          });
          return;
        }
      }

      const canHandle = handler.canHandle ? await handler.canHandle(req) : true;
      if (!canHandle) {
        logger.debug('handler declined to handle', {
          requestEventId,
          pmi: message.params.pmi,
        });
        synthesizeClientDeclineError({
          message: 'Payment declined by client handler',
        });
        return;
      }

      logger.debug('invoking payment handler', {
        requestEventId,
        handler: handler.constructor.name,
        pmi: message.params.pmi,
      });

      await handler.handle(req);

      logger.info('payment handler completed successfully', {
        requestEventId,
        pmi: message.params.pmi,
      });
    } catch (error) {
      logger.error('payment handler failed', {
        requestEventId,
        pmi: message.params.pmi,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      inFlightPayReqs.delete(message.params.pay_req);
    }
  }

  const wrapped = {
    get onmessage() {
      return onmessage;
    },
    set onmessage(fn) {
      onmessage = fn;
    },
    get onerror() {
      return onerror;
    },
    set onerror(fn) {
      onerror = fn;
    },
    get onclose() {
      return onclose;
    },
    set onclose(fn) {
      onclose = fn;
    },

    async start(): Promise<void> {
      // Only suppress notifications in `onmessage` when the transport delivers
      // them through a separate context path (NostrClientTransport).
      const hasContextPath = supportsOnmessageWithContext(transport);

      transport.onmessage = (message: JSONRPCMessage) => {
        // `NostrClientTransport` delivers notifications through BOTH `onmessage`
        // and `onmessageWithContext`. Forward only from the context path to avoid
        // duplicate delivery to the upstream MCP Protocol.
        if (hasContextPath && isJSONRPCNotification(message)) {
          return;
        }

        // Stop synthetic progress when the server responds (success or error).
        // message.id was restored to originalRequestId by resolveResponse().
        // When onprogress was set, originalRequestId = progressToken, making this stop exact.
        // Otherwise syntheticProgress has no entry and the call is a no-op.
        if (
          isJSONRPCResultResponse(message) ||
          isJSONRPCErrorResponse(message)
        ) {
          stopSyntheticProgress(String(message.id));
          if (!isExplicitPaymentRequiredError(message) && !isExplicitPaymentPendingError(message)) {
            const reqId = message.id as string | number;
            rawRequestCache.delete(reqId);
            retryCounts.delete(reqId);
          }
        }

        if (hasContextPath) {
          return;
        }

        // Best-effort: execute handler asynchronously, but never block delivery.
        void maybeHandlePaymentRequired(message, 'unknown').catch(
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            onerror?.(error);
          },
        );

        // If it's an explicit gating error, we intercept it here because
        // maybeHandlePaymentRequired takes responsibility for re-emitting it if unhandled.
        if (isExplicitPaymentRequiredError(message) || isExplicitPaymentPendingError(message)) {
          return;
        }

        onmessage?.(message);
      };

      if (hasContextPath) {
        transport.onmessageWithContext = (
          message: JSONRPCMessage,
          ctx: { eventId: string; correlatedEventId?: string },
        ) => {
          const requestEventId = ctx.correlatedEventId ?? 'unknown';

          // Stop synthetic progress on terminal outcomes (context path).
          if (isJSONRPCNotification(message)) {
            const isAccepted = message.method === PAYMENT_ACCEPTED_METHOD;
            const isRejected = message.method === PAYMENT_REJECTED_METHOD;
            if (isAccepted || isRejected) {
              const pending =
                transport instanceof NostrClientTransport
                  ? transport.getPendingRequestForEventId(requestEventId)
                  : undefined;
              if (pending?.progressToken) {
                stopSyntheticProgress(pending.progressToken);
              }
              // On rejection, synthesize a JSON-RPC error response so the caller's
              // pending promise is rejected immediately rather than timing out after 60 s.
              // The server never calls forward() for a rejected payment, so no real
              // response will arrive.
              if (isRejected && pending?.originalRequestId != null) {
                const rejMsg = (message as PaymentRejectedNotification).params
                  ?.message;
                onmessage?.({
                  jsonrpc: '2.0',
                  id: pending.originalRequestId,
                  error: {
                    code: -32000,
                    message: rejMsg
                      ? `Payment rejected: ${rejMsg}`
                      : 'Payment rejected',
                  },
                } as JSONRPCMessage);
                return;
              }
            }
          }

          void maybeHandlePaymentRequired(message, requestEventId).catch(
            (err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              onerror?.(error);
            },
          );

          // If it's an explicit gating error, we intercept it here because
          // maybeHandlePaymentRequired takes responsibility for re-emitting it if unhandled.
          if (isExplicitPaymentRequiredError(message) || isExplicitPaymentPendingError(message)) {
            return;
          }

          // Forward exactly once (see duplicate-delivery guard in `transport.onmessage`).
          onmessage?.(message);
        };
      }

      transport.onerror = (err: Error) => onerror?.(err);
      transport.onclose = () => {
        stopAllSyntheticProgress();
        onclose?.();
      };
      await transport.start();
    },

    async send(message: JSONRPCMessage): Promise<void> {
      if ('method' in message && 'id' in message && message.id != null) {
        rawRequestCache.set(message.id, message as JSONRPCRequest);
      }
      await transport.send(message);
    },

    async close(): Promise<void> {
      // stopAllSyntheticProgress is called via transport.onclose, no need to call it here
      await transport.close();
    },
  };

  return wrapped;
}
