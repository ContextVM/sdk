import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJSONRPCNotification,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { PaymentHandler, PaymentRequiredNotification } from './types.js';

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
  const handlersByPmi = new Map(
    options.handlers.map((h) => [h.pmi, h] as const),
  );

  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  let onerror: ((error: Error) => void) | undefined;
  let onclose: (() => void) | undefined;

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
      transport.onmessage = (message: JSONRPCMessage) => {
        // Best-effort: execute handler asynchronously, but never block delivery.
        void (async () => {
          if (isPaymentRequiredNotification(message)) {
            const handler = handlersByPmi.get(message.params.pmi);
            if (!handler) {
              return;
            }

            const req = {
              amount: message.params.amount,
              pay_req: message.params.pay_req,
              description: message.params.description,
              requestEventId: 'unknown',
            };

            const canHandle = handler.canHandle
              ? await handler.canHandle(req)
              : true;
            if (!canHandle) {
              return;
            }

            await handler.handle(req);
          }
        })().catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          onerror?.(error);
        });

        onmessage?.(message);
      };
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
