import { type JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  CorrelatedNotificationSender,
  PaymentAcceptedNotification,
  PaymentProcessor,
  PaymentRequiredNotification,
  PricedCapability,
  ServerMiddlewareFn,
  isJsonRpcRequest,
} from './types.js';
import { LruCache } from '../core/utils/lru-cache.js';

export interface ServerPaymentsOptions {
  processors: readonly PaymentProcessor[];
  pricedCapabilities: readonly PricedCapability[];
  /**
   * Maximum time to keep a request in pending-payment state.
   * @default 60_000
   */
  paymentTtlMs?: number;

  /**
   * Maximum number of concurrent pending-payment request ids to track.
   *
   * This is a DoS/memory-safety guardrail.
   * @default 1000
   */
  maxPendingPayments?: number;
}

function purgeExpiredPending(params: {
  pending: LruCache<{ expiresAtMs: number }>;
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

function matchPricedCapability(
  message: JSONRPCRequest,
  priced: readonly PricedCapability[],
): PricedCapability | undefined {
  const capabilityName = getCapabilityNameForPricing(message);

  return priced.find((p) => {
    if (p.method !== message.method) return false;
    if (p.name === undefined) return true;
    return p.name === capabilityName;
  });
}

function getCapabilityNameForPricing(message: JSONRPCRequest): string | undefined {
  const params = message.params as Record<string, unknown> | undefined;

  switch (message.method) {
    case 'tools/call': {
      const name = params?.name;
      return typeof name === 'string' ? name : undefined;
    }
    case 'prompts/get': {
      const name = params?.name;
      return typeof name === 'string' ? name : undefined;
    }
    case 'resources/read': {
      const uri = params?.uri;
      return typeof uri === 'string' ? uri : undefined;
    }
    default:
      return undefined;
  }
}

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
    method: 'notifications/payment_required',
    params,
  };
}

function createPaymentAcceptedNotification(params: {
  amount: number;
  pmi: string;
  receipt?: string;
  _meta?: Record<string, unknown>;
}): PaymentAcceptedNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/payment_accepted',
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
  const processorsByPmi = new Map(
    options.processors.map((p) => [p.pmi, p] as const),
  );

  const paymentTtlMs = options.paymentTtlMs ?? 60_000;
  const pending = new LruCache<{ expiresAtMs: number }>(
    options.maxPendingPayments ?? 1000,
  );

  return async (message, ctx, forward) => {
    // Only gate requests. Never interfere with notifications.
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
    const now = Date.now();

    // Opportunistic cleanup so one-shot spam doesn't accumulate until reuse.
    purgeExpiredPending({ pending, nowMs: now, maxToCheck: 25 });

    const existing = pending.get(requestEventId);
    if (existing && existing.expiresAtMs > now) {
      // Duplicate request event id: idempotency guard. Do not double-charge.
      return;
    }

    pending.set(requestEventId, { expiresAtMs: now + paymentTtlMs });

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

      const processor =
        processorsByPmi.get(chosenProcessor.pmi) ?? chosenProcessor;

      const paymentRequired = await processor.createPaymentRequired({
        amount: priced.amount,
        description: priced.description,
        requestEventId,
        clientPubkey: ctx.clientPubkey,
      });

      const requiredNotification = createPaymentRequiredNotification({
        amount: paymentRequired.amount,
        pay_req: paymentRequired.pay_req,
        pmi: paymentRequired.pmi,
        description: paymentRequired.description,
        ttl: paymentRequired.ttl,
        _meta: paymentRequired._meta,
      });

      await sender.sendNotification(
        ctx.clientPubkey,
        requiredNotification,
        requestEventId,
      );

      const verified = await processor.verifyPayment({
        pay_req: paymentRequired.pay_req,
        requestEventId,
        clientPubkey: ctx.clientPubkey,
      });

      const acceptedNotification = createPaymentAcceptedNotification({
        amount: paymentRequired.amount,
        pmi: paymentRequired.pmi,
        receipt: verified.receipt,
        _meta: verified._meta,
      });

      await sender.sendNotification(
        ctx.clientPubkey,
        acceptedNotification,
        requestEventId,
      );

      await forward(message);
    } finally {
      pending.delete(requestEventId);
    }
  };
}
