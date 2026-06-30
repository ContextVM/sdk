import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import {
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type JSONRPCNotification,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCErrorResponse,
} from '@contextvm/mcp-sdk/types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import type {
  PaymentHandler,
  PaymentRejectedNotification,
  PaymentRequiredNotification,
  PaymentHandlerRequest,
  PaymentInteractionMode,
  PaymentOption,
  PaymentRequiredErrorData,
  PaymentPendingErrorData,
} from './types.js';
import { LruCache } from '../core/utils/lru-cache.js';
import { createLogger } from '../core/utils/logger.js';
import type {
  OriginalRequestContext,
  PendingRequest,
} from '../transport/nostr-client/correlation-store.js';

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
  /**
   * Payment handlers for in-band (programmatic) payment, indexed by their
   * {@link PaymentHandler.pmi}. Each handler's `pmi` is advertised to the
   * server so it can pick a matching rail (the wallet-client fast path).
   *
   * **Omit entirely** for a PMI-agnostic client that pays out-of-band: no PMIs
   * are advertised, so per CEP-8 the server sends `payment_required` for any of
   * its processors. The notification is forwarded to the application via
   * `onmessage`, synthetic progress keeps the original MCP request alive while
   * the payment settles out-of-band, and the server's TTL is the timeout.
   */
  handlers?: readonly PaymentHandler[];
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
  paymentInteraction?: PaymentInteractionMode;

  /**
   * Maximum number of -32043 (Payment Pending) retries before giving up.
   *
   * With retry_after=2 and 1.5× exponential backoff capped at 10s, the default
   * of 10 retries gives ~45s of cumulative wait — enough for typical verification
   * flows. Increase for slow payment processors (e.g. on-chain confirmation).
   * @default 10
   */
  maxPendingRetries?: number;

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
   *
   * **Verify-timeout window**: if the server's verification times out or fails
   * after the client paid, its pending state is cleared and the client's retry
   * receives a fresh `-32042` with a new invoice (CEP-8-compliant). The wrapper
   * does not dedup across distinct `pay_req` values.
   */
  onPaymentRequired?: (params: {
    options: PaymentOption[];
    instructions?: string;
    originalRequest: JSONRPCRequest;
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
): msg is JSONRPCErrorResponse {
  return (
    isJSONRPCErrorResponse(msg) &&
    msg.error.code === PAYMENT_REQUIRED_ERROR_CODE &&
    typeof msg.error.data === 'object' &&
    msg.error.data !== null &&
    Array.isArray(
      (msg.error.data as { payment_options?: unknown }).payment_options,
    ) &&
    (msg.error.data as { payment_options: unknown[] }).payment_options.length >
      0
  );
}

function isExplicitPaymentPendingError(
  msg: JSONRPCMessage,
): msg is JSONRPCErrorResponse {
  return (
    isJSONRPCErrorResponse(msg) &&
    msg.error.code === PAYMENT_PENDING_ERROR_CODE &&
    typeof msg.error.data === 'object' &&
    msg.error.data !== null &&
    typeof (msg.error.data as { retry_after?: unknown }).retry_after ===
      'number'
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
  const rawRequestCache = new LruCache<JSONRPCRequest>(1000);
  const MAX_RETRIES = options.maxPendingRetries ?? 10;

  /**
   * Disposes all client-side payment state: synthetic progress, pending retry
   * timers, retry counters, and the raw-request cache. Called on transport close.
   */
  const disposeClientState = (): void => {
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

  // Ensure CEP-8 discovery/negotiation: when using Nostr transports, always
  // advertise the handler PMIs in preference order. Omitting handlers entirely
  // advertises no PMI, so the server sends payment_required for any processor
  // (CEP-8: client that specified no PMI).
  const advertisedPmis = (options.handlers ?? []).map((h) => h.pmi);
  if (transport instanceof NostrClientTransport) {
    transport.setClientPmis(advertisedPmis);
    logger.debug('advertised client PMIs', { pmis: advertisedPmis });
    if (options.paymentInteraction === 'explicit_gating') {
      transport.setPaymentInteraction('explicit_gating');
      logger.debug('advertised requested payment interaction mode', {
        mode: 'explicit_gating',
      });
    }
  }

  // Index handlers by PMI. Warn on duplicates — Map construction silently keeps
  // only the last.
  const handlersByPmi = new Map<string, PaymentHandler>();
  for (const h of options.handlers ?? []) {
    if (handlersByPmi.has(h.pmi)) {
      logger.warn('duplicate PMI handler registered, last one wins', {
        pmi: h.pmi,
      });
    }
    handlersByPmi.set(h.pmi, h);
  }

  // Prevent double-paying if relays or servers deliver duplicate payment_required notifications.
  const inFlightPayReqs = new Set<string>();

  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  let onerror: ((error: Error) => void) | undefined;
  let onclose: (() => void) | undefined;

  /** Emits a synthesized JSON-RPC error to the upstream consumer via `onmessage`. */
  const synthesizePaymentError = (params: {
    id: string | number | undefined;
    code: number;
    message: string;
    data: Record<string, unknown>;
  }): void => {
    onmessage?.({
      jsonrpc: '2.0',
      id: params.id,
      error: {
        code: params.code,
        message: params.message,
        data: params.data,
      },
    } as JSONRPCMessage);
  };

  /**
   * Synthesize a generic `-32000` decline for the original request, carrying the
   * PMI/amount and the original request's method/capability. No-op when there
   * is no correlated pending request to fail. Shared by the no-handler,
   * explicit-gating-rejected, and payment_rejected paths.
   */
  const synthesizePaymentDecline = (
    pending: PendingRequest | undefined,
    message: string,
    pmi: string,
    amount: number,
  ): void => {
    if (pending?.originalRequestId == null) {
      return;
    }
    synthesizePaymentError({
      id: pending.originalRequestId,
      code: -32000,
      message,
      data: {
        pmi,
        amount,
        method: pending.originalRequestContext?.method,
        capability: pending.originalRequestContext?.capability,
      },
    });
  };

  /**
   * Handles explicit-gating -32042 (invoke `onPaymentRequired`, then retry) and
   * -32043 (backoff, then retry). Both are intercepted here, never forwarded.
   */
  async function handleExplicitPaymentError(
    message: JSONRPCMessage,
    requestEventId: string,
  ): Promise<void> {
    if (isExplicitPaymentRequiredError(message)) {
      const errorMsg = message;
      const data = errorMsg.error.data as PaymentRequiredErrorData;

      if (!options.onPaymentRequired) {
        onmessage?.(message);
        return;
      }

      const requestId = errorMsg.id;
      const rawRequest =
        requestId != null ? rawRequestCache.get(String(requestId)) : undefined;
      if (!rawRequest) {
        logger.warn(
          'missing raw original request, cannot retry explicit payment',
          { requestEventId },
        );
        onmessage?.(message);
        return;
      }

      logger.info('invoking onPaymentRequired for explicit gating', {
        requestEventId,
        optionsCount: data.payment_options.length,
      });

      try {
        const result = await options.onPaymentRequired({
          options: data.payment_options,
          instructions: data.instructions,
          originalRequest: rawRequest,
        });

        if (result.paid) {
          logger.info('explicit payment satisfied, retrying original request', {
            requestEventId,
            method: rawRequest.method,
          });
          await transport.send(rawRequest);
          return;
        }

        logger.debug('onPaymentRequired returned paid=false', {
          requestEventId,
          reason: result.reason,
        });
        synthesizePaymentError({
          id: errorMsg.id,
          code: PAYMENT_REQUIRED_ERROR_CODE,
          message: 'Payment Required',
          data: { reason: result.reason || 'user_cancelled' },
        });
      } catch (err) {
        logger.error('onPaymentRequired callback failed', {
          requestEventId,
          error: err instanceof Error ? err.message : String(err),
        });
        synthesizePaymentError({
          id: errorMsg.id,
          code: PAYMENT_REQUIRED_ERROR_CODE,
          message: 'Payment Required',
          data: {
            reason: err instanceof Error ? err.message : String(err),
            type: 'payment_handler_error',
          },
        });
      }
      return;
    }

    // -32043 Payment Pending
    if (isExplicitPaymentPendingError(message)) {
      const errorMsg = message;
      const data = errorMsg.error.data as PaymentPendingErrorData;
      const retryAfterSeconds = data.retry_after;

      const requestId = errorMsg.id;
      const rawRequest =
        requestId != null ? rawRequestCache.get(String(requestId)) : undefined;
      if (!rawRequest) {
        logger.warn(
          'missing raw original request, cannot retry explicit payment pending',
          { requestEventId },
        );
        onmessage?.(message);
        return;
      }

      const requestIdKey = errorMsg.id as string | number;
      const retries = retryCounts.get(requestIdKey) ?? 0;
      if (retries >= MAX_RETRIES) {
        logger.error('max explicit payment retries exceeded', {
          requestEventId,
          id: requestIdKey,
          maxRetries: MAX_RETRIES,
        });
        onmessage?.(message);
        return;
      }

      retryCounts.set(requestIdKey, retries + 1);

      logger.info('payment pending, retrying after backoff', {
        requestEventId,
        retryAfterSeconds,
        retryCount: retries + 1,
      });

      const baseDelayMs = (retryAfterSeconds ?? 1) * 1000;
      const exponentialMultiplier = Math.pow(1.5, retries);
      const delayMs = Math.min(baseDelayMs * exponentialMultiplier, 10000);

      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        transport.send(rawRequest).catch((err) => {
          logger.error('failed to retry pending request', {
            requestEventId,
            error: err instanceof Error ? err.message : String(err),
          });
          synthesizePaymentError({
            id: rawRequest.id,
            code: PAYMENT_PENDING_ERROR_CODE,
            message: 'Failed to retry pending request',
            data: {
              reason: err instanceof Error ? err.message : String(err),
            },
          });
        });
      }, delayMs);
      pendingTimers.add(timer);
    }
  }

  /**
   * Handles transparent `notifications/payment_required`: satisfies the request
   * in-band via configured handlers, gated by `paymentPolicy`, `canHandle`, and
   * the effective-mode guard.
   */
  async function handleTransparentPaymentRequired(
    message: PaymentRequiredNotification,
    requestEventId: string,
  ): Promise<void> {
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

    // CEP-8: a client that required explicit_gating SHOULD NOT auto-satisfy a
    // transparent payment_required when the server did not accept it.
    if (
      isNostrTransport &&
      options.paymentInteraction === 'explicit_gating' &&
      transport.getEffectivePaymentInteraction() !== 'explicit_gating'
    ) {
      logger.warn(
        'declining transparent payment_required: explicit_gating was not accepted by the server',
        { requestEventId, pmi: message.params.pmi },
      );
      synthesizePaymentDecline(
        pending,
        'Payment declined: explicit_gating was not accepted by the server',
        message.params.pmi,
        message.params.amount,
      );
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

    // Resolve an in-band handler for this PMI. If none matches, the payment is
    // left to the application: the notification was already forwarded via
    // onmessage, synthetic progress above keeps the request alive while it
    // settles out-of-band, and the server's TTL is the ultimate timeout.
    const handler = handlersByPmi.get(message.params.pmi);
    if (!handler) {
      logger.debug(
        'no in-band handler for PMI; leaving payment to the application',
        {
          pmi: message.params.pmi,
          requestEventId,
        },
      );
      return;
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
        if (pending?.progressToken) {
          stopSyntheticProgress(pending.progressToken);
        }
        synthesizePaymentDecline(pending, params.message, req.pmi, req.amount);
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

  /** Classifies an inbound payment message and delegates to the relevant handler. */
  async function maybeHandlePaymentRequired(
    message: JSONRPCMessage,
    requestEventId: string,
  ): Promise<void> {
    if (
      isExplicitPaymentRequiredError(message) ||
      isExplicitPaymentPendingError(message)
    ) {
      await handleExplicitPaymentError(message, requestEventId);
      return;
    }
    if (isPaymentRequiredNotification(message)) {
      await handleTransparentPaymentRequired(message, requestEventId);
      return;
    }
  }

  /**
   * Runs the payment handler, then forwards to the upstream consumer unless the
   * message is an explicit-gating error (those are re-emitted/retried internally).
   */
  const dispatchAndForward = (
    message: JSONRPCMessage,
    requestEventId: string,
  ): void => {
    void maybeHandlePaymentRequired(message, requestEventId).catch(
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        onerror?.(error);
      },
    );
    if (
      isExplicitPaymentRequiredError(message) ||
      isExplicitPaymentPendingError(message)
    ) {
      return;
    }
    onmessage?.(message);
  };

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
          if (
            !isExplicitPaymentRequiredError(message) &&
            !isExplicitPaymentPendingError(message)
          ) {
            const reqId = message.id as string | number;
            rawRequestCache.delete(String(reqId));
            retryCounts.delete(reqId);
          }
        }

        if (hasContextPath) {
          return;
        }

        // Best-effort: execute handler asynchronously, but never block delivery.
        dispatchAndForward(message, 'unknown');
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

          // Forward exactly once (see duplicate-delivery guard in `transport.onmessage`).
          dispatchAndForward(message, requestEventId);
        };
      }

      transport.onerror = (err: Error) => onerror?.(err);
      transport.onclose = () => {
        disposeClientState();
        onclose?.();
      };
      await transport.start();
    },

    async send(message: JSONRPCMessage): Promise<void> {
      if ('method' in message && 'id' in message && message.id != null) {
        rawRequestCache.set(String(message.id), message as JSONRPCRequest);
      }
      await transport.send(message);
    },

    async close(): Promise<void> {
      // disposeClientState is called via transport.onclose, no need to call it here
      await transport.close();
    },
  };

  return wrapped;
}
