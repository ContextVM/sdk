import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  JSONRPCNotification,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
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

  const stopAllSyntheticProgress = (): void => {
    syntheticProgress.clear();
    if (syntheticProgressScheduler) {
      clearInterval(syntheticProgressScheduler);
      syntheticProgressScheduler = undefined;
    }
  };

  // Ensure CEP-8 discovery/negotiation: when using Nostr transports, always advertise
  // supported PMIs derived from the handler list (preference order = handler order).
  if (transport instanceof NostrClientTransport) {
    transport.setClientPmis(options.handlers.map((h) => h.pmi));
    logger.debug('advertised client PMIs', {
      pmis: options.handlers.map((h) => h.pmi),
    });
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
    if (!isPaymentRequiredNotification(message)) {
      return;
    }

    // If the transport can provide the original request's progressToken, emit synthetic
    // progress notifications locally to keep the upstream MCP request alive while the
    // payment settles (CEP-8 TTL can exceed the default MCP timeout).
    if (transport instanceof NostrClientTransport) {
      const pending = transport.getPendingRequestForEventId(requestEventId);
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

    const handler = handlersByPmi.get(message.params.pmi);
    if (!handler) {
      logger.debug('no handler for PMI, ignoring payment_required', {
        pmi: message.params.pmi,
        requestEventId,
      });
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

      const pending =
        transport instanceof NostrClientTransport
          ? transport.getPendingRequestForEventId(requestEventId)
          : undefined;

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
        }

        // Best-effort: execute handler asynchronously, but never block delivery.
        void maybeHandlePaymentRequired(message, 'unknown').catch(
          (err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            onerror?.(error);
          },
        );

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
      await transport.send(message);
    },

    async close(): Promise<void> {
      // stopAllSyntheticProgress is called via transport.onclose, no need to call it here
      await transport.close();
    },
  };

  return wrapped;
}
