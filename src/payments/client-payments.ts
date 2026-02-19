import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  JSONRPCNotification,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PaymentHandler, PaymentRequiredNotification } from './types.js';
import { createLogger } from '../core/utils/logger.js';
import { DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS } from './constants.js';

type TransportWithOptionalContext = Transport & {
  onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { eventId: string; correlatedEventId?: string },
  ) => void;
};

export interface ClientPaymentsOptions {
  handlers: readonly PaymentHandler[];
  /**
   * Interval for synthetic progress heartbeats (milliseconds).
   *
   * @default DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS (30000 ms)
   * Chosen to be half of the upstream MCP SDK default request timeout (60 s),
   * ensuring a heartbeat arrives before the first timeout would fire.
   */
  syntheticProgressIntervalMs?: number;
}

type ProgressToken = string;

type SyntheticProgressEntry = {
  stopAtMs: number;
  wireProgressToken: string | number;
};

function isPaymentRequiredNotification(
  msg: JSONRPCMessage,
): msg is PaymentRequiredNotification {
  return (
    isJSONRPCNotification(msg) &&
    msg.method === 'notifications/payment_required'
  );
}

/**
 * Wraps a transport to automatically handle CEP-8 payment requests.
 */
export function withClientPayments(
  transport: Transport,
  options: ClientPaymentsOptions,
): Transport {
  const logger = createLogger('client-payments');

  const syntheticProgressIntervalMs =
    options.syntheticProgressIntervalMs ??
    DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS;

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
          // Arbitrary non-terminal progress value. Receivers treat this as heartbeat.
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
      const ttlSeconds = message.params.ttl;
      if (
        token &&
        typeof ttlSeconds === 'number' &&
        Number.isFinite(ttlSeconds)
      ) {
        // Guard against nonsensical TTLs.
        const ttlMs = Math.floor(ttlSeconds * 1000);
        if (ttlMs > 0 && !syntheticProgress.has(token)) {
          const stopAtMs = Date.now() + ttlMs;

          const wireProgressToken = Number.isFinite(Number(token))
            ? Number(token)
            : token;
          syntheticProgress.set(token, { stopAtMs, wireProgressToken });
          ensureSchedulerStarted();
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
      const req = {
        amount: message.params.amount,
        pay_req: message.params.pay_req,
        description: message.params.description,
        requestEventId,
      };

      logger.info('processing payment_required', {
        requestEventId,
        pmi: message.params.pmi,
        amount: message.params.amount,
      });

      const canHandle = handler.canHandle ? await handler.canHandle(req) : true;
      if (!canHandle) {
        logger.debug('handler declined to handle', {
          requestEventId,
          pmi: message.params.pmi,
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

  const transportWithContext = transport as TransportWithOptionalContext;

  const wrapped: TransportWithOptionalContext = {
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
      const supportsContextNotifications =
        'onmessageWithContext' in transportWithContext;

      transport.onmessage = (message: JSONRPCMessage) => {
        // IMPORTANT (correctness): transports like `NostrClientTransport` may deliver
        // notifications through BOTH `onmessage` and `onmessageWithContext`.
        // In that case, only forward notifications from the context path to avoid
        // duplicate delivery to the upstream MCP Protocol.
        if (supportsContextNotifications && isJSONRPCNotification(message)) {
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

      // If underlying transport supports correlation context, use it to pass requestEventId.
      if ('onmessageWithContext' in transportWithContext) {
        transportWithContext.onmessageWithContext = (
          message: JSONRPCMessage,
          ctx: { eventId: string; correlatedEventId?: string },
        ) => {
          const requestEventId = ctx.correlatedEventId ?? 'unknown';

          // Stop synthetic progress on terminal outcomes (context path).
          // Use correlation store lookup (reliable) rather than relying on the server
          // to embed _meta.progressToken in these CEP-8 notifications.
          if (isJSONRPCNotification(message)) {
            if (
              message.method === 'notifications/payment_accepted' ||
              message.method === 'notifications/payment_rejected'
            ) {
              const progressToken =
                transport instanceof NostrClientTransport
                  ? transport.getPendingRequestForEventId(requestEventId)
                      ?.progressToken
                  : undefined;
              if (progressToken) {
                stopSyntheticProgress(progressToken);
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
