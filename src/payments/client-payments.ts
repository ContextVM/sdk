import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type JSONRPCMessage,
  type JSONRPCErrorResponse,
} from '@contextvm/mcp-sdk/types.js';
import {
  NostrClientTransport,
  type TransportWithContext,
} from '../transport/nostr-client-transport.js';
import type { PendingRequest } from '../transport/nostr-client/correlation-store.js';
import { createLogger } from '../core/utils/logger.js';
import type {
  PaymentHandler,
  PaymentHandlerRequest,
  PaymentOption,
  PaymentRequiredNotification,
} from './types.js';
import type { ClientPaymentsOptions } from './client-payment-options.js';
import {
  ClientPaymentAttempts,
  type ClientPaymentAttempt,
} from './client-payment-attempts.js';
import {
  ClientPaymentLifecycle,
  type ClientPaymentRequest,
} from './client-payment-lifecycle.js';
import { ClientPaymentProgress } from './client-payment-progress.js';
import {
  ClientPaymentError,
  parseClientPaymentOption,
  parseClientPaymentRequired,
  parseClientPaymentPending,
  validateClientPaymentOptions,
} from './client-payment-validation.js';
import {
  DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS,
  DEFAULT_PAYMENT_TTL_MS,
  PAYMENT_ACCEPTED_METHOD,
  PAYMENT_REJECTED_METHOD,
  PAYMENT_REQUIRED_METHOD,
  PAYMENT_REQUIRED_ERROR_CODE,
  PAYMENT_PENDING_ERROR_CODE,
} from './constants.js';

export type {
  ClientPaymentsOptions,
  ClientPaymentLimits,
} from './client-payment-options.js';

const clientPaymentsWrapped = new WeakSet<object>();

function isPaymentOffer(
  message: JSONRPCMessage,
): message is PaymentRequiredNotification {
  // Classify by envelope before schema helpers can reject malformed params.
  return (
    'method' in message &&
    message.method === PAYMENT_REQUIRED_METHOD &&
    !('id' in message)
  );
}

function isExplicitPaymentError(
  message: JSONRPCMessage,
): message is JSONRPCErrorResponse {
  return (
    isJSONRPCErrorResponse(message) &&
    (message.error.code === PAYMENT_REQUIRED_ERROR_CODE ||
      message.error.code === PAYMENT_PENDING_ERROR_CODE)
  );
}

function cancelledRequestId(
  message: JSONRPCMessage,
): string | number | undefined {
  if (
    !isJSONRPCNotification(message) ||
    message.method !== 'notifications/cancelled'
  )
    return undefined;
  const id = message.params?.requestId;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

/**
 * Wraps a transport with validated CEP-8 offers, bounded payment attempts, and
 * request-owned retries. Nostr peers are authenticated by their transport;
 * generic transports isolate attempt history per wrapper and must keep their
 * peer identity stable. History is retained for the lifetime of the wrapper.
 *
 * Unmatched handlers leave transparent payment to the application. Generic
 * notifications without request correlation support legacy handler execution,
 * but per-invocation limits require an identifiable original request.
 */
export function withClientPayments(
  transport: Transport,
  options: ClientPaymentsOptions,
): Transport {
  if (clientPaymentsWrapped.has(transport))
    throw new Error('withClientPayments already called on this transport');
  validateClientPaymentOptions(options);
  const logger = createLogger('client-payments');
  const nostr =
    transport instanceof NostrClientTransport ? transport : undefined;
  const minRetryDelayMs = Math.max(
    options.minRetryDelayMs ?? 1000,
    nostr ? 1000 : 0,
  );
  const maxRetries = options.maxPendingRetries ?? 10;
  const defaultTtlMs = options.defaultPaymentTtlMs ?? DEFAULT_PAYMENT_TTL_MS;
  const limits = options.limits && {
    ...options.limits,
    maxAmountByPmi: options.limits.maxAmountByPmi && {
      ...options.limits.maxAmountByPmi,
    },
  };
  let onmessage: Transport['onmessage'];
  let onerror: Transport['onerror'];
  let onclose: Transport['onclose'];
  const progress = new ClientPaymentProgress(
    options.syntheticProgressIntervalMs ??
      DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS,
    (message) => onmessage?.(message),
  );

  const emitFailure = (
    state: ClientPaymentRequest,
    error: ClientPaymentError,
    code = -32000,
    data: Record<string, unknown> = {},
  ): void => {
    if (state.id === undefined) {
      onerror?.(error);
      return;
    }
    onmessage?.({
      jsonrpc: '2.0',
      id: state.id,
      error: {
        code,
        message: error.message,
        data: { reason: error.reason, ...data },
      },
    });
  };
  const lifecycle = new ClientPaymentLifecycle(limits, emitFailure, (state) => {
    progress.stop(state.key);
    if (state.id !== undefined)
      nostr?.forgetPendingRequestsForRequestId(state.id);
  });
  const attempts = new ClientPaymentAttempts(
    options.maxTrackedPaymentAttempts ?? 1000,
  );
  const handlers = new Map<string, PaymentHandler>();
  for (const handler of options.handlers ?? []) {
    if (handlers.has(handler.pmi))
      logger.warn('duplicate PMI handler registered, last one wins', {
        pmi: handler.pmi,
      });
    handlers.set(handler.pmi, handler);
  }
  nostr?.setClientPmis([...handlers.keys()]);
  if (options.paymentInteraction)
    nostr?.setPaymentInteraction(options.paymentInteraction);

  const fail = (
    state: ClientPaymentRequest,
    error: ClientPaymentError,
    code = -32000,
    data: Record<string, unknown> = {},
  ): void => {
    if (!lifecycle.isActive(state)) return;
    lifecycle.finish(state);
    emitFailure(state, error, code, data);
  };

  const scheduleRetry = (
    state: ClientPaymentRequest,
    delayMs: number,
    code: number,
  ): void => {
    if (
      !lifecycle.isActive(state) ||
      !state.request ||
      state.retryTimer !== undefined
    )
      return;
    state.retryTimer = setTimeout(
      () => {
        state.retryTimer = undefined;
        if (!lifecycle.isActive(state) || !state.request) return;
        void transport.send(state.request).catch((error: unknown) => {
          fail(
            state,
            new ClientPaymentError(
              'payment_retry_failed',
              'Failed to retry payment request',
            ),
            code,
            { detail: error instanceof Error ? error.message : String(error) },
          );
        });
      },
      Math.max(delayMs, minRetryDelayMs),
    );
  };

  const priorOutcome = async (
    state: ClientPaymentRequest,
    attempt: ClientPaymentAttempt,
    explicit: boolean,
  ): Promise<void> => {
    await attempt.completion;
    if (!lifecycle.isActive(state)) return;
    if (attempt.outcome === 'handled') {
      if (explicit)
        scheduleRetry(state, minRetryDelayMs, PAYMENT_PENDING_ERROR_CODE);
    } else {
      fail(
        state,
        new ClientPaymentError(
          attempt.outcome === 'unknown'
            ? 'payment_outcome_unknown'
            : 'payment_previously_declined',
          attempt.outcome === 'unknown'
            ? 'Payment outcome is uncertain; reconcile before paying again'
            : 'Payment was previously declined',
        ),
        explicit ? PAYMENT_REQUIRED_ERROR_CODE : -32000,
        { outcome: attempt.outcome },
      );
    }
  };

  async function explicitPayment(message: JSONRPCErrorResponse): Promise<void> {
    const state = message.id != null ? lifecycle.get(message.id) : undefined;
    if (!state) {
      onmessage?.(message);
      return;
    }
    if (!lifecycle.isActive(state)) return;
    lifecycle.startPayment(state);
    if (message.error.code === PAYMENT_PENDING_ERROR_CODE) {
      const data = parseClientPaymentPending(message.error.data);
      if (!state.request) {
        lifecycle.finish(state);
        onmessage?.(message);
        return;
      }
      if (state.retryTimer !== undefined) return;
      if (state.retries >= maxRetries) {
        lifecycle.finish(state);
        onmessage?.(message);
        return;
      }
      const multiplier = Math.pow(1.5, state.retries++);
      const baseDelay = (data.retry_after ?? 1) * 1000;
      const delay =
        baseDelay === 0 ? 0 : Math.min(baseDelay * multiplier, 10000);
      scheduleRetry(state, delay, PAYMENT_PENDING_ERROR_CODE);
      return;
    }
    const data = parseClientPaymentRequired(message.error.data);
    if (!options.onPaymentRequired || !state.request) {
      lifecycle.finish(state);
      onmessage?.(message);
      return;
    }
    const prior = attempts.find(data.payment_options);
    if (prior) {
      await priorOutcome(state, prior, true);
      return;
    }
    if (state.paymentInFlight) {
      throw new ClientPaymentError(
        'payment_outcome_unknown',
        'Another payment decision is still in progress for this invocation',
      );
    }
    const allowed = lifecycle.approve(state, data.payment_options);
    const attempt = attempts.reserve(allowed, state.controller.signal);
    state.paymentInFlight = true;
    try {
      const result = await options.onPaymentRequired({
        options: allowed,
        instructions: data.instructions,
        originalRequest: JSON.parse(
          JSON.stringify(state.request),
        ) as NonNullable<typeof state.request>,
        abortSignal: state.controller.signal,
      });
      if (!lifecycle.isActive(state)) return;
      if (result.paid) {
        attempt.complete('handled');
        scheduleRetry(state, minRetryDelayMs, PAYMENT_REQUIRED_ERROR_CODE);
      } else {
        attempt.complete('declined');
        fail(
          state,
          new ClientPaymentError(
            result.reason || 'user_cancelled',
            'Payment Required',
          ),
          PAYMENT_REQUIRED_ERROR_CODE,
        );
      }
    } catch (error: unknown) {
      attempt.complete('unknown');
      if (lifecycle.isActive(state))
        fail(
          state,
          new ClientPaymentError(
            error instanceof Error ? error.message : String(error),
            'Payment Required',
          ),
          PAYMENT_REQUIRED_ERROR_CODE,
          { type: 'payment_handler_error', outcome: 'unknown' },
        );
    } finally {
      state.paymentInFlight = false;
    }
  }

  function transparentState(
    eventId: string,
    pending?: PendingRequest,
  ): ClientPaymentRequest | undefined {
    if (nostr && !pending) return undefined;
    if (pending?.originalRequestId != null)
      return lifecycle.correlated(pending.originalRequestId);
    const state = lifecycle.onlyRequest();
    if (state) return state;
    if (lifecycle.hasRequests()) {
      onerror?.(
        new ClientPaymentError(
          'payment_request_uncorrelated',
          'Payment notification is ambiguous between active requests',
        ),
      );
      return undefined;
    }
    return lifecycle.detached(eventId);
  }

  async function transparentPayment(
    option: PaymentOption,
    eventId: string,
    state: ClientPaymentRequest,
    pending?: PendingRequest,
  ): Promise<void> {
    if (!lifecycle.isActive(state)) return;
    if (
      nostr &&
      options.paymentInteraction === 'explicit_gating' &&
      nostr.getEffectivePaymentInteraction() !== 'explicit_gating'
    ) {
      fail(
        state,
        new ClientPaymentError(
          'payment_negotiation_failed',
          'Payment declined: explicit_gating was not accepted by the server',
        ),
        -32000,
        {
          pmi: option.pmi,
          amount: option.amount,
          method: pending?.originalRequestContext?.method,
          capability: pending?.originalRequestContext?.capability,
        },
      );
      return;
    }
    lifecycle.startPayment(state);
    if (nostr && pending?.progressToken)
      progress.start(
        state.key,
        pending.progressToken,
        option.ttl !== undefined ? option.ttl * 1000 : defaultTtlMs,
      );
    const handler = handlers.get(option.pmi);
    if (!handler || !lifecycle.isActive(state)) return;
    if (limits && state.id === undefined)
      throw new ClientPaymentError(
        'payment_request_uncorrelated',
        'Payment limits require a correlated original request',
      );
    const prior = attempts.find([option]);
    if (prior) {
      await priorOutcome(state, prior, false);
      return;
    }
    if (state.paymentInFlight)
      throw new ClientPaymentError(
        'payment_outcome_unknown',
        'Another payment decision is still in progress for this invocation',
      );
    lifecycle.approve(state, [option]);
    const attempt = attempts.reserve([option], state.controller.signal);
    state.paymentInFlight = true;
    const req: PaymentHandlerRequest = {
      amount: option.amount,
      pmi: option.pmi,
      pay_req: option.pay_req,
      description: option.description,
      ttl: option.ttl,
      _meta: option._meta,
      requestEventId: eventId,
      abortSignal: state.controller.signal,
    };
    const decline = (message: string): void => {
      attempt.complete('declined');
      fail(state, new ClientPaymentError('payment_declined', message), -32000, {
        pmi: option.pmi,
        amount: option.amount,
        method: pending?.originalRequestContext?.method,
        capability: pending?.originalRequestContext?.capability,
      });
    };
    let walletStarted = false;
    const expiresAt =
      option.ttl !== undefined ? Date.now() + option.ttl * 1000 : undefined;
    try {
      if (options.paymentPolicy) {
        const approved = await options.paymentPolicy(
          { ...req },
          pending?.originalRequestContext,
        );
        if (!lifecycle.isActive(state)) return;
        if (!approved) {
          decline('Payment declined by client policy');
          return;
        }
      }
      const canHandle = handler.canHandle
        ? await handler.canHandle({ ...req })
        : await Promise.resolve(true);
      if (!lifecycle.isActive(state)) return;
      if (!canHandle) {
        decline('Payment declined by client handler');
        return;
      }
      if (expiresAt !== undefined && Date.now() >= expiresAt) {
        attempt.complete('declined');
        throw new ClientPaymentError(
          'payment_offer_expired',
          'Payment offer expired before wallet action',
        );
      }
      walletStarted = true;
      await handler.handle(req);
      if (lifecycle.isActive(state)) attempt.complete('handled');
    } catch (error: unknown) {
      attempt.complete(walletStarted ? 'unknown' : 'declined');
      if (!lifecycle.isActive(state)) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      fail(
        state,
        error instanceof ClientPaymentError
          ? error
          : new ClientPaymentError(
              'payment_handler_error',
              `Payment handler failed: ${failure.message}`,
            ),
        -32000,
        {
          pmi: option.pmi,
          amount: option.amount,
          outcome: walletStarted ? 'unknown' : 'declined',
        },
      );
      if (state.id !== undefined && !(error instanceof ClientPaymentError))
        onerror?.(failure);
    } finally {
      state.paymentInFlight = false;
    }
  }

  function dispatch(message: JSONRPCMessage, eventId: string): void {
    if (lifecycle.isClosed) return;
    const cancelled = cancelledRequestId(message);
    if (cancelled !== undefined) {
      const state = lifecycle.get(cancelled);
      if (state) lifecycle.finish(state);
      onmessage?.(message);
      return;
    }
    if (isExplicitPaymentError(message)) {
      const state = message.id != null ? lifecycle.get(message.id) : undefined;
      void explicitPayment(message).catch((error: unknown) => {
        const failure =
          error instanceof ClientPaymentError
            ? error
            : new ClientPaymentError(
                'invalid_payment',
                'Invalid payment message',
              );
        if (state) fail(state, failure, message.error.code);
        else onerror?.(failure);
      });
      return;
    }
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const state = message.id != null ? lifecycle.get(message.id) : undefined;
      if (state && !state.active) return;
      if (state) lifecycle.finish(state);
      onmessage?.(message);
      return;
    }
    if (isPaymentOffer(message)) {
      const pending = nostr?.getPendingRequestForEventId(eventId);
      const state = transparentState(eventId, pending);
      if (!state || !lifecycle.isActive(state)) {
        onmessage?.(message);
        return;
      }
      let option: PaymentOption;
      try {
        option = parseClientPaymentOption(message.params);
      } catch (error: unknown) {
        fail(state, error as ClientPaymentError);
        return;
      }
      void transparentPayment(option, eventId, state, pending).catch(
        (error: unknown) => {
          fail(
            state,
            error instanceof ClientPaymentError
              ? error
              : new ClientPaymentError('payment_handler_error', String(error)),
          );
        },
      );
      onmessage?.(message);
      return;
    }
    if (
      isJSONRPCNotification(message) &&
      (message.method === PAYMENT_ACCEPTED_METHOD ||
        message.method === PAYMENT_REJECTED_METHOD)
    ) {
      const pending = nostr?.getPendingRequestForEventId(eventId);
      const state =
        pending?.originalRequestId != null
          ? lifecycle.correlated(pending.originalRequestId)
          : lifecycle.onlyRequest();
      if (state) {
        progress.stop(state.key);
        if (message.method === PAYMENT_REJECTED_METHOD) {
          const detail =
            typeof message.params?.message === 'string'
              ? message.params.message
              : undefined;
          fail(
            state,
            new ClientPaymentError(
              'payment_rejected',
              detail ? `Payment rejected: ${detail}` : 'Payment rejected',
            ),
          );
          return;
        }
      }
    }
    onmessage?.(message);
  }

  const wrapped: Transport = {
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
      lifecycle.open();
      const hasContext = Object.prototype.hasOwnProperty.call(
        transport,
        'onmessageWithContext',
      );
      transport.onmessage = (message): void => {
        if (!hasContext) dispatch(message, 'unknown');
      };
      if (hasContext)
        (transport as TransportWithContext).onmessageWithContext = (
          message,
          ctx,
        ): void => {
          dispatch(message, ctx.correlatedEventId ?? 'unknown');
        };
      transport.onerror = (error): void => onerror?.(error);
      transport.onclose = (): void => {
        lifecycle.close();
        progress.clear();
        onclose?.();
      };
      try {
        await transport.start();
      } catch (error) {
        lifecycle.close();
        progress.clear();
        throw error;
      }
    },
    async send(message: JSONRPCMessage): Promise<void> {
      if (lifecycle.isClosed)
        throw new Error('Client payments transport is closed');
      const cancelled = cancelledRequestId(message);
      if (cancelled !== undefined) {
        const state = lifecycle.get(cancelled);
        if (state) lifecycle.finish(state);
      }
      const state = isJSONRPCRequest(message)
        ? lifecycle.register(message)
        : undefined;
      try {
        await transport.send(message);
      } catch (error) {
        if (state) lifecycle.finish(state);
        throw error;
      }
    },
    async close(): Promise<void> {
      lifecycle.close();
      progress.clear();
      await transport.close();
    },
  };
  clientPaymentsWrapped.add(transport);
  clientPaymentsWrapped.add(wrapped);
  return wrapped;
}
