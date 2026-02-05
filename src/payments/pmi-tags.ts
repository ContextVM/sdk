import {
  isJSONRPCRequest,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { PaymentHandler } from './types.js';

/**
 * Builds Nostr `pmi` tags for a set of handlers.
 *
 * Tag order is preserved and expresses client preference.
 */
export function createPmiTagsFromHandlers(
  handlers: readonly PaymentHandler[],
): string[][] {
  return handlers.map((h) => ['pmi', h.pmi]);
}

/**
 * Creates an outboundTagHook for NostrClientTransport that advertises supported PMIs.
 *
 * The hook only injects tags for JSON-RPC requests.
 */
export function createClientPmiOutboundTagHook(
  handlers: readonly PaymentHandler[],
): (message: JSONRPCMessage) => string[][] {
  const tags = createPmiTagsFromHandlers(handlers);

  return (message) => {
    if (!isJSONRPCRequest(message)) {
      return [];
    }
    return tags;
  };
}
