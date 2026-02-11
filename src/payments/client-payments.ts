import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJSONRPCNotification,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PaymentHandler, PaymentRequiredNotification } from './types.js';

type TransportWithOptionalContext = Transport & {
  onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { eventId: string; correlatedEventId?: string },
  ) => void;
};

export interface ClientPaymentsOptions {
  handlers: readonly PaymentHandler[];
}

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
  // Ensure CEP-8 discovery/negotiation: when using Nostr transports, always advertise
  // supported PMIs derived from the handler list (preference order = handler order).
  if (transport instanceof NostrClientTransport) {
    transport.setClientPmis(options.handlers.map((h) => h.pmi));
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
    const handler = handlersByPmi.get(message.params.pmi);
    if (!handler) {
      return;
    }

    // Best-effort client-side dedupe keyed by pay_req.
    // IMPORTANT: claim synchronously before any await to avoid double-pay races.
    if (inFlightPayReqs.has(message.params.pay_req)) {
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

      const canHandle = handler.canHandle ? await handler.canHandle(req) : true;
      if (!canHandle) {
        return;
      }

      await handler.handle(req);
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
      transport.onmessage = (message: JSONRPCMessage) => {
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
          void maybeHandlePaymentRequired(message, requestEventId).catch(
            (err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              onerror?.(error);
            },
          );

          // Keep message delivery consistent with the plain `onmessage` path.
          onmessage?.(message);
        };
      }

      transport.onerror = (err: Error) => onerror?.(err);
      transport.onclose = () => onclose?.();
      await transport.start();
    },

    async send(message: JSONRPCMessage): Promise<void> {
      await transport.send(message);
    },

    async close(): Promise<void> {
      await transport.close();
    },
  };

  return wrapped;
}
