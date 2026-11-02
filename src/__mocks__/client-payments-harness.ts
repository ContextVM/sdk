import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';
import {
  withClientPayments,
  type ClientPaymentsOptions,
} from '../payments/client-payments.js';
import type { PaymentOption } from '../payments/types.js';
import { waitFor as waitForValue } from '../core/utils/test.utils.js';

/** Coordinates isolated test work without changing the global clock. */
export async function waitFor(
  condition: () => boolean,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await waitForValue({
    produce: () => (condition() ? true : undefined),
    timeoutMs: options.timeoutMs ?? 1000,
    intervalMs: 2,
  });
}

/** Builds or advances isolated payment test state. */
export const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
/** Builds or advances isolated payment test state. */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
/** Builds or advances isolated payment test state. */
export const request = (id: string | number = 1): JSONRPCRequest => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'paid', arguments: { value: id } },
});
/** Builds or advances isolated payment test state. */
export const option = (
  pay_req = 'invoice',
  amount = 5,
  pmi = 'fake',
): PaymentOption => ({ amount, pmi, pay_req });
/** Builds or advances isolated payment test state. */
export const offer = (input: unknown = option()): JSONRPCMessage =>
  ({
    jsonrpc: '2.0',
    method: 'notifications/payment_required',
    params: input,
  }) as JSONRPCMessage;
/** Builds or advances isolated payment test state. */
export const required = (
  id: string | number = 1,
  options: unknown = [option()],
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32042,
    message: 'Payment Required',
    data: { payment_options: options },
  },
});
/** Builds or advances isolated payment test state. */
export const pending = (
  id: string | number = 1,
  retry_after?: unknown,
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32043,
    message: 'Payment Pending',
    data: retry_after === undefined ? {} : { retry_after },
  },
});
/** Lets a test decide when an external payment action completes. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** One transport, its wrapper, and all observable test outcomes. */
export interface Harness {
  paid: Transport;
  base: Transport;
  sent: JSONRPCMessage[];
  received: JSONRPCMessage[];
  errors: Error[];
  deliver: (message: JSONRPCMessage) => void;
}
/** Coordinates isolated test work without changing the global clock. */
export async function run(
  options: ClientPaymentsOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const sent: JSONRPCMessage[] = [];
  const received: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  const base: Transport = {
    async start(): Promise<void> {},
    async send(message): Promise<void> {
      sent.push(message);
    },
    async close(): Promise<void> {}, // Deliberately does not fire onclose.
  };
  const paid = withClientPayments(base, { minRetryDelayMs: 2, ...options });
  paid.onmessage = (message): void => {
    received.push(message);
  };
  paid.onerror = (error): void => {
    errors.push(error);
  };
  await paid.start();
  try {
    await body({
      paid,
      base,
      sent,
      received,
      errors,
      deliver: (message): void => base.onmessage?.(message),
    });
  } finally {
    await paid.close();
  }
}
/** Collects terminal errors observed by the test caller. */
export function failures(
  harness: Harness,
): Array<{ error: { data?: unknown } }> {
  return harness.received.filter((message) => 'error' in message) as Array<{
    error: { data?: unknown };
  }>;
}
