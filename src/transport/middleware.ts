import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';

import type { PaymentInteractionMode } from '../payments/types.js';

/**
 * Inbound middleware hook for server transports.
 *
 * @note Context relationship: `InboundMiddlewareFn`'s `ctx` is the authoritative source
 * of per-request context, populated by the inbound coordinator from the session and
 * inbound event tags. `ServerPaymentsContext` (used by `ServerMiddlewareFn`) is a subset
 * of this context — it reads the same `paymentInteraction` field. The inbound coordinator
 * constructs both from the same session state, so they stay synchronized automatically.
 */
export type InboundMiddlewareFn = (
  message: JSONRPCMessage,
  ctx: {
    clientPubkey: string;
    clientPmis?: readonly string[];
    paymentInteraction?: PaymentInteractionMode;
  },
  forward: (message: JSONRPCMessage) => Promise<void>,
) => Promise<void>;
