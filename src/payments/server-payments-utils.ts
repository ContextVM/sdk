import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  PricedCapability,
  ResolvePriceRejection,
  ResolvePriceWaiver,
  ResolvePriceResult,
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
  return Math.floor(ttlSeconds * 1000);
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
