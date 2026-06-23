import { describe, expect, test } from 'bun:test';
import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import { withClientPayments } from './client-payments.js';
import type { PaymentHandlerRequest } from './types.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';

/** Minimal fake transport that exposes onmessageWithContext for unit tests. */
type TransportWithContext = Transport & {
  onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { eventId: string; correlatedEventId?: string },
  ) => void;
};

const createMockNostrTransport = (): NostrClientTransport => {
  const hub = new MockRelayHub();
  return new NostrClientTransport({
    signer: new PrivateKeySigner('1'.repeat(64)),
    relayHandler: hub.createRelayHandler(),
    serverPubkey: '2'.repeat(64),
    encryptionMode: EncryptionMode.DISABLED,
    isStateless: true,
  });
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
    const transport = createMockNostrTransport();

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
    const transport = createMockNostrTransport();

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

  test('declines transparent payment_required when client requested explicit_gating but server did not accept it', async () => {
    const transport = createMockNostrTransport();

    const observed: JSONRPCMessage[] = [];
    let handleCalls = 0;
    const paid = withClientPayments(transport, {
      handlers: [
        {
          pmi: 'fake',
          async handle(): Promise<void> {
            handleCalls += 1;
          },
        },
      ],
      paymentInteraction: 'explicit_gating',
    });

    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    // Server never disclosed explicit_gating, so getEffectivePaymentInteraction() is undefined.
    (
      transport as unknown as {
        correlationStore: {
          registerRequest: (eventId: string, req: unknown) => void;
        };
      }
    ).correlationStore.registerRequest('req-event-id', {
      originalRequestId: 7,
      isInitialize: false,
      progressToken: undefined,
      originalRequestContext: { method: 'tools/call', capability: 'tool:paid' },
    });

    (transport as unknown as TransportWithContext).onmessageWithContext?.(
      {
        jsonrpc: '2.0',
        method: 'notifications/payment_required',
        params: { amount: 1, pay_req: 'z', pmi: 'fake' },
      } as JSONRPCMessage,
      { eventId: 'evt', correlatedEventId: 'req-event-id' },
    );

    await new Promise((r) => setTimeout(r, 0));

    // CEP-8 effective-mode guard: handler MUST NOT be invoked.
    expect(handleCalls).toBe(0);
    const errResp = observed.find(
      (
        m,
      ): m is {
        jsonrpc: '2.0';
        id: number;
        error: { code: number; message: string; data?: unknown };
      } => 'id' in m && m.id === 7 && 'error' in m,
    );
    expect(errResp?.error?.code).toBe(-32000);
    expect(errResp?.error?.message).toBe(
      'Payment declined: explicit_gating was not accepted by the server',
    );
    expect(errResp?.error?.data).toEqual({
      pmi: 'fake',
      amount: 1,
      method: 'tools/call',
      capability: 'tool:paid',
    });
  });

  test('proceeds with transparent payment when server accepted explicit_gating for the session', async () => {
    const transport = createMockNostrTransport();

    let observed: PaymentHandlerRequest | undefined;
    const paid = withClientPayments(transport, {
      handlers: [
        {
          pmi: 'fake',
          async handle(req): Promise<void> {
            observed = req;
          },
        },
      ],
      paymentInteraction: 'explicit_gating',
    });

    await paid.start();

    // Server disclosed explicit_gating as the effective mode for the session.
    (
      transport as unknown as {
        metadataStore: {
          setEffectivePaymentInteraction: (mode: string) => void;
        };
      }
    ).metadataStore.setEffectivePaymentInteraction('explicit_gating');
    (
      transport as unknown as {
        correlationStore: {
          registerRequest: (eventId: string, req: unknown) => void;
        };
      }
    ).correlationStore.registerRequest('req-event-id', {
      originalRequestId: 8,
      isInitialize: false,
      progressToken: undefined,
      originalRequestContext: undefined,
    });

    (transport as unknown as TransportWithContext).onmessageWithContext?.(
      {
        jsonrpc: '2.0',
        method: 'notifications/payment_required',
        params: { amount: 1, pay_req: 'w', pmi: 'fake' },
      } as JSONRPCMessage,
      { eventId: 'evt', correlatedEventId: 'req-event-id' },
    );

    await new Promise((r) => setTimeout(r, 0));

    // Guard does not fire: handler IS invoked.
    expect(observed).toBeDefined();
    expect(observed?.pmi).toBe('fake');
  });

  test('drops uncorrelated payment_required notifications on Nostr transports', async () => {
    const transport = createMockNostrTransport();

    let canHandleCalls = 0;
    let handleCalls = 0;
    const observed: JSONRPCMessage[] = [];

    const paid = withClientPayments(transport, {
      handlers: [
        {
          pmi: 'fake',
          async canHandle(): Promise<boolean> {
            canHandleCalls += 1;
            return true;
          },
          async handle(): Promise<void> {
            handleCalls += 1;
          },
        },
      ],
    });

    paid.onmessage = (msg) => observed.push(msg);

    await paid.start();

    const paymentRequired: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: { amount: 1, pay_req: 'x', pmi: 'fake' },
    };

    (transport as unknown as TransportWithContext).onmessageWithContext?.(
      paymentRequired,
      {
        eventId: 'evt',
        correlatedEventId: undefined,
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(observed).toContainEqual(paymentRequired);
    expect(canHandleCalls).toBe(0);
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
    const transport = createMockNostrTransport();

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
    const transport = createMockNostrTransport();

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
    const transport = createMockNostrTransport();

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

  test('handles explicit gating -32042 error and retries request', async () => {
    const transport = createMockNostrTransport();
    let sentMessage: JSONRPCMessage | undefined;
    transport.send = async (msg) => {
      sentMessage = msg;
    };

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id-3', {
        originalRequestId: 77,
        isInitialize: false,

        originalRequestContext: { method: 'tools/call' },
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => ({ paid: true }),
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    // Populate the wrapper's cache with the original request
    await paid.send({
      jsonrpc: '2.0',
      id: 77,
      method: 'tools/call',
      params: { name: 'test' },
    });
    sentMessage = undefined; // Reset mock state so we can observe the retry

    // Deliver -32042 Payment Required error
    transport.onmessageWithContext!(
      {
        jsonrpc: '2.0',
        id: 77,
        error: {
          code: -32042,
          message: 'Payment Required',
          data: {
            payment_options: [{ amount: 10, pmi: 'fake', pay_req: 'pr1' }],
          },
        },
      },
      { eventId: 'evt4', correlatedEventId: 'req-event-id-3' },
    );

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 0));

    // Error should not be delivered to caller
    expect(observed).toHaveLength(0);

    // Original request should be retried
    expect(sentMessage as unknown).toEqual({
      jsonrpc: '2.0',
      id: 77,
      method: 'tools/call',
      params: { name: 'test' },
    });

    await paid.close();
  });

  test('propagates -32042 error if onPaymentRequired returns paid: false', async () => {
    const transport = createMockNostrTransport();

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id-4', {
        originalRequestId: 88,
        isInitialize: false,

        originalRequestContext: { method: 'tools/call' },
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => ({
        paid: false,
        reason: 'user_cancelled',
      }),
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    // Populate the wrapper's cache with the original request
    await paid.send({
      jsonrpc: '2.0',
      id: 88,
      method: 'tools/call',
      params: { name: 'test' },
    });

    // Deliver -32042 Payment Required error
    transport.onmessageWithContext!(
      {
        jsonrpc: '2.0',
        id: 88,
        error: {
          code: -32042,
          message: 'Payment Required',
          data: {
            payment_options: [{ amount: 10, pmi: 'fake', pay_req: 'pr2' }],
          },
        },
      },
      { eventId: 'evt5', correlatedEventId: 'req-event-id-4' },
    );

    await new Promise((r) => setTimeout(r, 0));

    // Error should be delivered to caller with reason
    expect(observed).toHaveLength(1);
    const errResp = observed[0] as {
      id?: unknown;
      error?: { code?: number; data?: { reason?: string } };
    };
    expect(errResp.id).toBe(88);
    expect(errResp.error?.code).toBe(-32042);
    expect(errResp.error?.data?.reason).toBe('user_cancelled');

    await paid.close();
  });

  test('handles explicit gating -32043 Payment Pending error and retries after backoff', async () => {
    const transport = createMockNostrTransport();
    let sentMessage: JSONRPCMessage | undefined;
    transport.send = async (msg) => {
      sentMessage = msg;
    };

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id-5', {
        originalRequestId: 99,
        isInitialize: false,

        originalRequestContext: { method: 'tools/call' },
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      paymentInteraction: 'explicit_gating',
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    // Populate the wrapper's cache with the original request
    await paid.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'test_pending' },
    });
    sentMessage = undefined; // Reset mock state so we can observe the retry

    // Deliver -32043 Payment Pending error
    transport.onmessageWithContext!(
      {
        jsonrpc: '2.0',
        id: 99,
        error: {
          code: -32043,
          message: 'Payment Pending',
          data: {
            instructions: 'Wait and retry.',
            retry_after: 0.05, // 50ms for test
          },
        },
      },
      { eventId: 'evt6', correlatedEventId: 'req-event-id-5' },
    );

    // Initial check: Should intercept error and wait
    await new Promise((r) => setTimeout(r, 10));
    expect(observed).toHaveLength(0);
    expect(sentMessage).toBeUndefined();

    // Wait for retry_after timer to fire
    await new Promise((r) => setTimeout(r, 60));

    // Error should not be delivered to caller
    expect(observed).toHaveLength(0);

    // Original request should be retried
    expect(sentMessage as unknown).toEqual({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'test_pending' },
    });

    await paid.close();
  });

  test('synthesizes -32042 with type payment_handler_error when onPaymentRequired rejects', async () => {
    const transport = createMockNostrTransport();

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id-reject', {
        originalRequestId: 55,
        isInitialize: false,
        originalRequestContext: { method: 'tools/call' },
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => {
        throw new Error('wallet offline');
      },
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    await paid.send({
      jsonrpc: '2.0',
      id: 55,
      method: 'tools/call',
      params: { name: 'test' },
    });

    (transport as unknown as TransportWithContext).onmessageWithContext?.(
      {
        jsonrpc: '2.0',
        id: 55,
        error: {
          code: -32042,
          message: 'Payment Required',
          data: {
            payment_options: [
              { amount: 10, pmi: 'fake', pay_req: 'pr-reject' },
            ],
          },
        },
      },
      { eventId: 'evt', correlatedEventId: 'req-event-id-reject' },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(observed).toHaveLength(1);
    const errResp = observed[0] as {
      id?: unknown;
      error?: {
        code?: number;
        data?: { reason?: string; type?: string };
      };
    };
    expect(errResp.id).toBe(55);
    expect(errResp.error?.code).toBe(-32042);
    expect(errResp.error?.data?.reason).toBe('wallet offline');
    expect(errResp.error?.data?.type).toBe('payment_handler_error');

    await paid.close();
  });

  test('forwards -32043 to caller after maxPendingRetries is exceeded', async () => {
    const transport = createMockNostrTransport();
    transport.send = async (): Promise<void> => {
      // no-op: retries do not produce a server response in this unit test
    };

    transport
      .getInternalStateForTesting()
      .correlationStore.registerRequest('req-event-id-exhaust', {
        originalRequestId: 66,
        isInitialize: false,
        originalRequestContext: { method: 'tools/call' },
      });

    const observed: JSONRPCMessage[] = [];
    const paid = withClientPayments(transport, {
      handlers: [{ pmi: 'fake', async handle(): Promise<void> {} }],
      paymentInteraction: 'explicit_gating',
      maxPendingRetries: 2,
    });
    paid.onmessage = (msg) => observed.push(msg);
    await paid.start();

    await paid.send({
      jsonrpc: '2.0',
      id: 66,
      method: 'tools/call',
      params: { name: 'test' },
    });

    const deliverPending = (): void => {
      (transport as unknown as TransportWithContext).onmessageWithContext?.(
        {
          jsonrpc: '2.0',
          id: 66,
          error: {
            code: -32043,
            message: 'Payment Pending',
            data: { retry_after: 0.01 },
          },
        },
        { eventId: 'evt', correlatedEventId: 'req-event-id-exhaust' },
      );
    };

    // First two: intercepted and retried (not observed by caller).
    deliverPending();
    await new Promise((r) => setTimeout(r, 20));
    expect(observed).toHaveLength(0);

    deliverPending();
    await new Promise((r) => setTimeout(r, 25));
    expect(observed).toHaveLength(0);

    // Third: retry budget exhausted → -32043 reaches the caller.
    deliverPending();
    await new Promise((r) => setTimeout(r, 0));

    expect(observed).toHaveLength(1);
    const errResp = observed[0] as {
      id?: unknown;
      error?: { code?: number };
    };
    expect(errResp.id).toBe(66);
    expect(errResp.error?.code).toBe(-32043);

    await paid.close();
  });
});
