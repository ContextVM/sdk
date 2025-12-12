import {
  JSONRPCMessage,
  JSONRPCMessageSchema,
  JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Sleeps for a specified number of milliseconds.
 * @param ms The number of milliseconds to sleep.
 * @returns A promise that resolves after the specified number of milliseconds.
 */
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Validates a message against the MCP SDK's JSON-RPC message schema.
 * @param message The message to validate.
 * @returns The validated JSONRPCMessage if valid, null otherwise.
 */
export function validateMessage(message: unknown): JSONRPCMessage | null {
  try {
    return JSONRPCMessageSchema.parse(message);
  } catch {
    return null;
  }
}

/**
 * Injects the client's public key into the _meta field of an MCP request message.
 * This function performs in-place mutation for optimal performance.
 *
 * @param request The JSON-RPC request message to modify (must be a request).
 * @param clientPubkey The client's Nostr public key to inject.
 */
export function injectClientPubkey(
  request: JSONRPCRequest,
  clientPubkey: string,
): void {
  // Only inject if params exists
  if (!request.params) {
    return;
  }

  // In-place mutation: create or update _meta with clientPubkey
  if (!request.params._meta) {
    request.params._meta = { clientPubkey };
  } else {
    request.params._meta.clientPubkey = clientPubkey;
  }
}
