import { describe, expect, test } from 'bun:test';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { withClientPayments } from './client-payments.js';
import type { PaymentHandlerRequest } from './types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PendingRequest } from '../transport/nostr-client/correlation-store.js';

type TransportWithContext = Transport & {
  onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { eventId: string; correlatedEventId?: string },
  ) => void;
};

describe('withClientPayments()', () => {
  test('passes correlatedEventId as requestEventId when transport provides onmessageWithContext', async () => {
    let observed: PaymentHandlerRequest | undefined;

    const baseTransport: TransportWithContext = {
      onmessage: undefined,
      onmessageWithContext: undefined,
      onerror: undefined,
      onclose: undefined,
      async start(): Promise<void> {},
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };

    const paid = withClientPayments(baseTransport, {
      handlers: [
        {
          pmi: 'fake',
          async handle(req): Promise<void> {
            observed = req;
          },
        },
      ],
    }) as TransportWithContext;

    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'fake' },
    };

    baseTransport.onmessageWithContext?.(paymentRequired, {
      eventId: 'evt',
      correlatedEventId: 'req-id',
    });

    // Handler execution is async/best-effort; wait a tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(observed).toEqual({
      amount: 1,
      pay_req: 'x',
      description: undefined,
      requestEventId: 'req-id',
    });
  });

  test('dedupes concurrent payment_required notifications with the same pay_req', async () => {
    let handleCalls = 0;

    const baseTransport: TransportWithContext = {
      onmessage: undefined,
      onmessageWithContext: undefined,
      onerror: undefined,
      onclose: undefined,
      async start(): Promise<void> {},
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };

    const paid = withClientPayments(baseTransport, {
      handlers: [
        {
          pmi: 'fake',
          async handle(): Promise<void> {
            handleCalls += 1;
            // Force overlap to simulate duplicate concurrent delivery.
            await new Promise((r) => setTimeout(r, 5));
          },
        },
      ],
    }) as TransportWithContext;

    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'same', pmi: 'fake' },
    };

    baseTransport.onmessageWithContext?.(paymentRequired, {
      eventId: 'evt-1',
      correlatedEventId: 'req-id',
    });
    baseTransport.onmessageWithContext?.(paymentRequired, {
      eventId: 'evt-2',
      correlatedEventId: 'req-id',
    });

    // Handler execution is async/best-effort; wait long enough for completion.
    await new Promise((r) => setTimeout(r, 20));

    expect(handleCalls).toBe(1);
  });

  test('ignores payment_required notifications for unsupported PMI', async () => {
    let handleCalls = 0;

    const baseTransport: TransportWithContext = {
      onmessage: undefined,
      onmessageWithContext: undefined,
      onerror: undefined,
      onclose: undefined,
      async start(): Promise<void> {},
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };

    const paid = withClientPayments(baseTransport, {
      handlers: [
        {
          pmi: 'supported',
          async handle(): Promise<void> {
            handleCalls += 1;
          },
        },
      ],
    }) as TransportWithContext;

    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'unsupported' },
    };

    baseTransport.onmessageWithContext?.(paymentRequired, {
      eventId: 'evt',
      correlatedEventId: 'req-id',
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(handleCalls).toBe(0);
  });

  test('does not pay when canHandle returns false', async () => {
    let handleCalls = 0;

    const baseTransport: TransportWithContext = {
      onmessage: undefined,
      onmessageWithContext: undefined,
      onerror: undefined,
      onclose: undefined,
      async start(): Promise<void> {},
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };

    const paid = withClientPayments(baseTransport, {
      handlers: [
        {
          pmi: 'fake',
          async canHandle(): Promise<boolean> {
            return false;
          },
          async handle(): Promise<void> {
            handleCalls += 1;
          },
        },
      ],
    }) as TransportWithContext;

    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'fake' },
    };

    baseTransport.onmessageWithContext?.(paymentRequired, {
      eventId: 'evt',
      correlatedEventId: 'req-id',
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(handleCalls).toBe(0);
  });

  test('handler errors call onerror but do not block message delivery', async () => {
    const observed: JSONRPCMessage[] = [];
    const errors: Error[] = [];

    const baseTransport: TransportWithContext = {
      onmessage: undefined,
      onmessageWithContext: undefined,
      onerror: undefined,
      onclose: undefined,
      async start(): Promise<void> {},
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };

    const paid = withClientPayments(baseTransport, {
      handlers: [
        {
          pmi: 'fake',
          async handle(): Promise<void> {
            throw new Error('wallet failed');
          },
        },
      ],
    }) as TransportWithContext;

    paid.onmessage = (msg) => {
      observed.push(msg);
    };
    paid.onerror = (err) => {
      errors.push(err);
    };

    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'fake' },
    };

    baseTransport.onmessageWithContext?.(paymentRequired, {
      eventId: 'evt',
      correlatedEventId: 'req-id',
    });

    // Message should be delivered synchronously (handler is best-effort async).
    expect(observed).toEqual([paymentRequired]);

    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/wallet failed/);
  });

  test('injects synthetic progress when payment_required includes ttl and request has progressToken', async () => {
    const observed: JSONRPCMessage[] = [];

    const baseTransport: Transport & {
      onmessageWithContext?: (
        message: JSONRPCMessage,
        ctx: { eventId: string; correlatedEventId?: string },
      ) => void;
    } = {
      onmessage: undefined,
      onmessageWithContext: undefined,
      onerror: undefined,
      onclose: undefined,
      async start(): Promise<void> {},
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };

    // Fake a NostrClientTransport instance for instanceof checks.
    const fakeNostrTransport = Object.assign(
      Object.create(NostrClientTransport.prototype),
      baseTransport,
      {
        setClientPmis(): void {},
        getPendingRequestForEventId(): PendingRequest | undefined {
          return {
            originalRequestId: 1,
            isInitialize: false,
            progressToken: '123',
          };
        },
      },
    ) as unknown as NostrClientTransport;

    const paid = withClientPayments(fakeNostrTransport, {
      handlers: [
        {
          pmi: 'fake',
          async handle(): Promise<void> {},
        },
      ],
      syntheticProgressIntervalMs: 5,
    });

    paid.onmessage = (msg) => observed.push(msg);

    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'fake', ttl: 60 },
    };

    fakeNostrTransport.onmessageWithContext?.(paymentRequired, {
      eventId: 'evt',
      correlatedEventId: 'req-event-id',
    });

    // payment_required is still forwarded synchronously; the immediate synthetic
    // heartbeat now precedes it in observed, so check presence rather than index.
    expect(observed).toContainEqual(paymentRequired);

    // Wait long enough for the interval to fire at least once.
    await new Promise((r) => setTimeout(r, 25));

    expect(
      observed.some(
        (m) =>
          (m as { method?: string }).method === 'notifications/progress' &&
          (m as { params?: { progressToken?: unknown } }).params
            ?.progressToken === 123,
      ),
    ).toBe(true);

    await paid.close();
  });
});
