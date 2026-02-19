import { describe, expect, test } from 'bun:test';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { withClientPayments } from './client-payments.js';
import type { PaymentHandlerRequest } from './types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import type { RelayHandler } from '../core/interfaces.js';

/** Minimal fake transport that exposes onmessageWithContext for unit tests. */
type TransportWithContext = Transport & {
  onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { eventId: string; correlatedEventId?: string },
  ) => void;
};

const noopRelay: RelayHandler = {
  connect: async () => {},
  disconnect: async () => {},
  publish: async () => {},
  subscribe: async () => () => {},
  unsubscribe: () => {},
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

  test('injects synthetic progress immediately and periodically when payment_required includes ttl', async () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: noopRelay,
      isStateless: true,
    });

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id', {
        originalRequestId: 123,
        isInitialize: false,
        progressToken: '123',
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      syntheticProgressIntervalMs: 5,
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'fake', ttl: 60 },
    };

    transport.onmessageWithContext!(paymentRequired, {
      eventId: 'evt',
      correlatedEventId: 'req-event-id',
    });

    // payment_required is forwarded and an immediate heartbeat fires synchronously.
    expect(observed).toContainEqual(paymentRequired);
    expect(
      observed.some(
        (m) =>
          (m as { method?: string }).method === 'notifications/progress' &&
          (m as { params?: { progressToken?: unknown } }).params
            ?.progressToken === 123,
      ),
    ).toBe(true);

    // Interval ticks also fire.
    await new Promise((r) => setTimeout(r, 25));
    const progressCount = observed.filter(
      (m) => (m as { method?: string }).method === 'notifications/progress',
    ).length;
    expect(progressCount).toBeGreaterThan(1);

    await paid.close();
  });
});
