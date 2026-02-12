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

/**
 * Wraps a Promise with a timeout.
 * @param promise The promise to wrap.
 * @param timeoutMs Timeout in milliseconds.
 * @param errorMessage Error message for the timeout.
 * @returns A promise that resolves or rejects with the original result/error, or rejects on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = 'Operation timed out',
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Validates a string as a 64-character hex string.
 * @param value - The string to validate
 * @returns Whether the string is a valid hex string
 */
export function isHex64(value: string | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Transforms Date.now() to seconds.
 * @returns The current time in seconds
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
