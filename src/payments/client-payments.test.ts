import { describe, expect, test } from 'bun:test';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { withClientPayments } from './client-payments.js';
import type { PaymentHandlerRequest } from './types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode, type RelayHandler } from '../core/interfaces.js';

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
      pmi: 'fake',
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

  test('synthesizes JSON-RPC error when canHandle declines and correlation exists', async () => {
    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner('1'.repeat(64)),
      relayHandler: noopRelay,
      serverPubkey: '2'.repeat(64),
      encryptionMode: EncryptionMode.DISABLED,
    });

    const observed: JSONRPCMessage[] = [];

    const paid = withClientPayments(transport, {
      handlers: [
        {
          pmi: 'fake',
          async canHandle(): Promise<boolean> {
            return false;
          },
          async handle(): Promise<void> {
            throw new Error('should not be called');
          },
        },
      ],
    });

    paid.onmessage = (msg) => observed.push(msg);

    await paid.start();

    // Inject correlation state directly.
    (
      transport as unknown as {
        correlationStore: {
          registerRequest: (eventId: string, req: unknown) => void;
        };
      }
    ).correlationStore.registerRequest('req-event-id', {
      originalRequestId: 42,
      isInitialize: false,
      progressToken: undefined,
      originalRequestContext: { method: 'tools/call', capability: 'tool:add' },
    });

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'fake' },
    };

    (transport as unknown as TransportWithContext).onmessageWithContext?.(
      paymentRequired,
      {
        eventId: 'evt',
        correlatedEventId: 'req-event-id',
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const errResp = observed.find(
      (
        m,
      ): m is {
        jsonrpc: '2.0';
        id: number;
        error: { code: number; message: string; data?: unknown };
      } => 'id' in m && m.id === 42 && 'error' in m,
    );
    expect(errResp?.error?.code).toBe(-32000);
    expect(errResp?.error?.message).toBe('Payment declined by client handler');
    expect(errResp?.error?.data).toEqual({
      pmi: 'fake',
      amount: 1,
      method: 'tools/call',
      capability: 'tool:add',
    });
  });

  test('synthesizes JSON-RPC error when paymentPolicy declines and correlation exists', async () => {
    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner('1'.repeat(64)),
      relayHandler: noopRelay,
      serverPubkey: '2'.repeat(64),
      encryptionMode: EncryptionMode.DISABLED,
    });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      paymentPolicy: async () => false,
    });

    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    (
      transport as unknown as {
        correlationStore: {
          registerRequest: (eventId: string, req: unknown) => void;
        };
      }
    ).correlationStore.registerRequest('req-event-id', {
      originalRequestId: 99,
      isInitialize: false,
      progressToken: undefined,
      originalRequestContext: {
        method: 'prompts/get',
        capability: 'prompt:hi',
      },
    });

    (transport as unknown as TransportWithContext).onmessageWithContext?.(
      {
        jsonrpc: '2.0',
        method: 'notifications/payment_required',
        params: { amount: 2, pay_req: 'y', pmi: 'fake' },
      } as JSONRPCMessage,
      {
        eventId: 'evt',
        correlatedEventId: 'req-event-id',
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    const errResp = observed.find(
      (
        m,
      ): m is {
        jsonrpc: '2.0';
        id: number;
        error: { code: number; message: string; data?: unknown };
      } => 'id' in m && m.id === 99 && 'error' in m,
    );
    expect(errResp?.error?.code).toBe(-32000);
    expect(errResp?.error?.message).toBe('Payment declined by client policy');
    expect(errResp?.error?.data).toEqual({
      pmi: 'fake',
      amount: 2,
      method: 'prompts/get',
      capability: 'prompt:hi',
    });
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

  test('synthesizes JSON-RPC error response on payment_rejected and stops synthetic progress', async () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: noopRelay,
      isStateless: true,
    });

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id', {
        originalRequestId: 42,
        isInitialize: false,
        progressToken: '42',
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      syntheticProgressIntervalMs: 60_000, // prevent interval ticks during test
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    // Start synthetic progress on payment_required, then discard all prior messages.
    transport.onmessageWithContext!(
      {
        jsonrpc: '2.0',
        method: 'notifications/payment_required',
        params: { amount: 1, pay_req: 'x', pmi: 'fake', ttl: 60 },
      },
      { eventId: 'evt1', correlatedEventId: 'req-event-id' },
    );
    observed.length = 0;

    // Deliver payment_rejected correlated to the same request.
    transport.onmessageWithContext!(
      {
        jsonrpc: '2.0',
        method: 'notifications/payment_rejected',
        params: { pmi: 'fake', amount: 1, message: 'You already have it' },
      },
      { eventId: 'evt2', correlatedEventId: 'req-event-id' },
    );

    // The notification itself is suppressed; a synthetic error response is forwarded instead.
    expect(observed).toHaveLength(1);
    const errResp = observed[0] as {
      id?: unknown;
      error?: { code?: number; message?: string };
      method?: string;
    };
    expect(errResp.id).toBe(42);
    expect(errResp.error?.code).toBe(-32000);
    expect(errResp.error?.message).toBe(
      'Payment rejected: You already have it',
    );
    // Must not look like a notification.
    expect(errResp.method).toBeUndefined();

    // Synthetic progress must be stopped — no more ticks arrive.
    await new Promise((r) => setTimeout(r, 20));
    expect(observed).toHaveLength(1);

    await paid.close();
  });

  test('synthesizes plain "Payment rejected" when payment_rejected carries no message', async () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: noopRelay,
      isStateless: true,
    });

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id-2', {
        originalRequestId: 99,
        isInitialize: false,
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    transport.onmessageWithContext!(
      {
        jsonrpc: '2.0',
        method: 'notifications/payment_rejected',
        params: { pmi: 'fake', amount: 1 },
      },
      { eventId: 'evt3', correlatedEventId: 'req-event-id-2' },
    );

    expect(observed).toHaveLength(1);
    const errResp = observed[0] as {
      id?: unknown;
      error?: { message?: string };
    };
    expect(errResp.id).toBe(99);
    expect(errResp.error?.message).toBe('Payment rejected');

    await paid.close();
  });
});
