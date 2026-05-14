import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Inbound middleware hook for server transports.
 */
export type InboundMiddlewareFn = (
  message: JSONRPCMessage,
  ctx: { clientPubkey: string; clientPmis?: readonly string[] },
  forward: (message: JSONRPCMessage) => Promise<void>,
) => Promise<void>;
