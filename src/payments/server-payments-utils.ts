import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  PricedCapability,
  ResolvePriceRejection,
  ResolvePriceWaiver,
  ResolvePriceResult,
  PaymentProcessor,
  PaymentRequired,
} from './types.js';

export function getVerificationTimeoutMs(params: {
  ttlSeconds: number | undefined;
}): number {
  // CEP-8 TTL is in seconds. If TTL is absent, default is 5 minutes.
  const ttlSeconds = params.ttlSeconds;
  if (ttlSeconds === undefined) {
    return 5 * 60 * 1000;
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return 5 * 60 * 1000;
  }
  const ms = ttlSeconds * 1000;
  return Number.isFinite(ms) ? Math.floor(ms) : 5 * 60 * 1000;
}

export function matchPricedCapability(
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

export function getCapabilityNameForPricing(
  message: JSONRPCRequest,
): string | undefined {
  const params = message.params as Record<string, unknown> | undefined;

  switch (message.method) {
    case 'tools/call':
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

export function isResolvePriceRejection(
  quote: ResolvePriceResult,
): quote is ResolvePriceRejection {
  return 'reject' in quote && quote.reject;
}

export function isResolvePriceWaiver(
  quote: ResolvePriceResult,
): quote is ResolvePriceWaiver {
  return 'waive' in quote && quote.waive;
}

export function resolvePaymentProcessor(
  clientPmis: readonly string[] | undefined,
  processorsByPmi: Map<string, PaymentProcessor>,
  processors: readonly PaymentProcessor[],
): PaymentProcessor {
  const chosenPmi = clientPmis
    ? clientPmis.find((pmi) => processorsByPmi.has(pmi))
    : undefined;

  const chosenProcessor = chosenPmi
    ? processorsByPmi.get(chosenPmi)
    : processors[0];

  if (!chosenProcessor) {
    throw new Error('No payment processors configured');
  }

  return chosenProcessor;
}

export type InitiationResult =
  | {
      kind: 'rejected';
      pmi: string;
      amount: number;
      message?: string;
      quote: ResolvePriceRejection;
    }
  | { kind: 'waived' }
  | {
      kind: 'payment_required';
      processor: PaymentProcessor;
      paymentRequired: PaymentRequired;
      mergedMeta: Record<string, unknown> | undefined;
      verifyTimeoutMs: number;
    };

export async function resolveAndInitiatePayment(params: {
  message: JSONRPCRequest;
  priced: PricedCapability;
  requestEventId: string;
  clientPubkey: string;
  clientPmis: readonly string[] | undefined;
  options: {
    processors: readonly PaymentProcessor[];
    resolvePrice?: (params: {
      capability: PricedCapability;
      request: JSONRPCRequest;
      clientPubkey: string;
      requestEventId: string;
    }) => Promise<ResolvePriceResult>;
  };
  processorsByPmi: Map<string, PaymentProcessor>;
}): Promise<InitiationResult> {
  const processor = resolvePaymentProcessor(
    params.clientPmis,
    params.processorsByPmi,
    params.options.processors,
  );

  const quote = params.options.resolvePrice
    ? await params.options.resolvePrice({
        capability: params.priced,
        request: params.message,
        clientPubkey: params.clientPubkey,
        requestEventId: params.requestEventId,
      })
    : { amount: params.priced.amount, description: params.priced.description };

  if (isResolvePriceRejection(quote)) {
    return {
      kind: 'rejected',
      pmi: processor.pmi,
      amount: params.priced.amount,
      message: quote.message,
      quote,
    };
  }

  if (isResolvePriceWaiver(quote)) {
    return { kind: 'waived' };
  }

  const resolvedQuote = quote;
  const paymentRequired = await processor.createPaymentRequired({
    amount: resolvedQuote.amount,
    description: resolvedQuote.description,
    requestEventId: params.requestEventId,
    clientPubkey: params.clientPubkey,
  });

  const mergedMeta =
    resolvedQuote.meta === undefined && paymentRequired._meta === undefined
      ? undefined
      : {
          ...(paymentRequired._meta ?? {}),
          ...(resolvedQuote.meta ?? {}),
        };

  const verifyTimeoutMs = getVerificationTimeoutMs({
    ttlSeconds: paymentRequired.ttl,
  });

  return {
    kind: 'payment_required',
    processor,
    paymentRequired,
    mergedMeta,
    verifyTimeoutMs,
  };
}
