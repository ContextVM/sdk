import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { CTXVM_MESSAGES_KIND } from '../core/index.js';
import type { NostrEvent } from 'nostr-tools';
import {
  FakePaymentHandler,
  FakePaymentProcessor,
  createServerPaymentsMiddleware,
  withClientPayments,
  withServerPayments,
} from '../payments/index.js';
import type { PaymentProcessor } from '../payments/types.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

function capturePaymentRequiredPmi(
  message: JSONRPCMessage,
): string | undefined {
  if (
    'method' in message &&
    message.method === 'notifications/payment_required' &&
    'params' in message
  ) {
    const params = (message as { params?: unknown }).params;
    if (
      typeof params === 'object' &&
      params !== null &&
      'pmi' in params &&
      typeof (params as { pmi?: unknown }).pmi === 'string'
    ) {
      return (params as { pmi: string }).pmi;
    }
  }
  return undefined;
}

let relayUrl: string;
let httpUrl: string;

async function captureNextCtxvmEvent(params: {
  relayUrl: string;
  authors: string[];
  where: (event: NostrEvent) => boolean;
  timeoutMs?: number;
}): Promise<NostrEvent> {
  const relayPool = new ApplesauceRelayPool([params.relayUrl]);
  await relayPool.connect();

  const timeoutMs = params.timeoutMs ?? 2000;
  return await new Promise<NostrEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for event'));
    }, timeoutMs);

    void relayPool.subscribe(
      [{ kinds: [CTXVM_MESSAGES_KIND], authors: params.authors }],
      (event) => {
        if (params.where(event)) {
          clearTimeout(timeout);
          resolve(event);
        }
      },
    );
  });
}

describe.serial('payments fake flow (transport-level)', () => {
  let stopRelay: (() => void) | undefined;

  beforeAll(async () => {
    const relay = await spawnMockRelay();
    stopRelay = relay.stop;
    relayUrl = relay.relayUrl;
    httpUrl = relay.httpUrl;
  });

  afterEach(async () => {
    await clearRelayCache(httpUrl);
  });

  afterAll(async () => {
    stopRelay?.();
    await sleep(100);
  });

  test('gates tools/call until payment is accepted (fake delays)', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({ name: 'paid-server', version: '1.0.0' });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    const processor = new FakePaymentProcessor({ verifyDelayMs: 80 });
    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    );

    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const handlers = [new FakePaymentHandler({ delayMs: 50 })];
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers,
    });

    const client = new Client({ name: 'paid-client', version: '1.0.0' });
    await client.connect(paidClientTransport);

    const startedAt = Date.now();
    const result = await client.callTool({
      name: 'add',
      arguments: { a: 1, b: 2 },
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(70);
    const typedResult = result as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(typedResult.content[0]).toMatchObject({ type: 'text', text: '3' });

    await client.close();
    await mcpServer.close();
  }, 20000);

  test('PMI selection: client preference wins when intersection exists', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({ name: 'paid-server', version: '1.0.0' });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    const processorB = new FakePaymentProcessor({
      pmi: 'pmi:B',
      verifyDelayMs: 1,
    });
    const processorC = new FakePaymentProcessor({
      pmi: 'pmi:C',
      verifyDelayMs: 1,
    });
    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processorB, processorC],
        pricedCapabilities: [...pricedCapabilities],
      },
    );

    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientPubkey = getPublicKey(clientSK);
    const handlers = [
      new FakePaymentHandler({ pmi: 'pmi:A', delayMs: 1 }),
      new FakePaymentHandler({ pmi: 'pmi:B', delayMs: 1 }),
    ];

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    // CEP-8: ensure PMI tags are actually published on the initialize request.
    const initializeEventPromise = captureNextCtxvmEvent({
      relayUrl,
      authors: [clientPubkey],
      where: (event) => {
        if (!event.content.includes('"method":"initialize"')) {
          return false;
        }
        return event.tags.some((t) => t[0] === 'pmi' && t[1] === 'pmi:A');
      },
    });

    let observedPaymentPmi: string | undefined;
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers,
    });
    const client = new Client({ name: 'paid-client', version: '1.0.0' });
    await client.connect(paidClientTransport);

    const initializeEvent = await initializeEventPromise;
    const pmiTags = initializeEvent.tags.filter((t) => t[0] === 'pmi');
    expect(pmiTags).toEqual([
      ['pmi', 'pmi:A'],
      ['pmi', 'pmi:B'],
    ]);

    const originalOnMessage = paidClientTransport.onmessage;
    paidClientTransport.onmessage = (msg) => {
      observedPaymentPmi ??= capturePaymentRequiredPmi(msg);
      originalOnMessage?.(msg);
    };

    await client.callTool({
      name: 'add',
      arguments: { a: 1, b: 2 },
    });

    expect(observedPaymentPmi).toBe('pmi:B');

    await client.close();
    await mcpServer.close();
  }, 20000);

  test('client publishes PMI tags on non-initialize paid requests (stateless paid call)', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({ name: 'paid-server', version: '1.0.0' });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => ({
        content: [{ type: 'text' as const, text: String(a + b) }],
      }),
    );

    const processor = new FakePaymentProcessor({ verifyDelayMs: 1 });
    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    );

    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientPubkey = getPublicKey(clientSK);
    const handlers = [new FakePaymentHandler({ pmi: 'pmi:A', delayMs: 1 })];

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    const paidClientTransport = withClientPayments(clientTransport, {
      handlers,
    });
    const client = new Client({ name: 'paid-client', version: '1.0.0' });

    // Ensure PMI tags are published on stateless paid requests (not just initialize).
    const callEventPromise = captureNextCtxvmEvent({
      relayUrl,
      authors: [clientPubkey],
      where: (event) => {
        if (!event.content.includes('"method":"tools/call"')) {
          return false;
        }
        return event.tags.some((t) => t[0] === 'pmi' && t[1] === 'pmi:A');
      },
      timeoutMs: 4000,
    });

    await client.connect(paidClientTransport);

    await client.callTool({
      name: 'add',
      arguments: { a: 1, b: 2 },
    });

    const callEvent = await callEventPromise;
    const pmiTags = callEvent.tags.filter((t) => t[0] === 'pmi');
    expect(pmiTags).toEqual([['pmi', 'pmi:A']]);

    await client.close();
    await mcpServer.close();
  }, 20000);

  test('PMI selection: falls back to server order when no intersection', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({ name: 'paid-server', version: '1.0.0' });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    const processorB = new FakePaymentProcessor({
      pmi: 'pmi:B',
      verifyDelayMs: 1,
    });
    const processorC = new FakePaymentProcessor({
      pmi: 'pmi:C',
      verifyDelayMs: 1,
    });
    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processorB, processorC],
        pricedCapabilities: [...pricedCapabilities],
      },
    );

    await mcpServer.connect(serverTransport);

    const clientPrivateKey = bytesToHex(generateSecretKey());
    const handlers = [new FakePaymentHandler({ pmi: 'pmi:A', delayMs: 1 })];

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    let observedPaymentPmi: string | undefined;
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers,
    });
    const client = new Client({ name: 'paid-client', version: '1.0.0' });
    await client.connect(paidClientTransport);

    const originalOnMessage = paidClientTransport.onmessage;
    paidClientTransport.onmessage = (msg) => {
      observedPaymentPmi ??= capturePaymentRequiredPmi(msg);
      originalOnMessage?.(msg);
    };

    await client.callTool({
      name: 'add',
      arguments: { a: 1, b: 2 },
    });

    expect(observedPaymentPmi).toBe('pmi:B');

    await client.close();
    await mcpServer.close();
  }, 20000);

  test('PMI selection: when client advertises none, uses server order', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({ name: 'paid-server', version: '1.0.0' });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    const processorB = new FakePaymentProcessor({
      pmi: 'pmi:B',
      verifyDelayMs: 1,
    });
    const processorC = new FakePaymentProcessor({
      pmi: 'pmi:C',
      verifyDelayMs: 1,
    });
    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processorB, processorC],
        pricedCapabilities: [...pricedCapabilities],
      },
    );

    await mcpServer.connect(serverTransport);

    const clientPrivateKey = bytesToHex(generateSecretKey());
    const handlers = [new FakePaymentHandler({ delayMs: 1 })];
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    let observedPaymentPmi: string | undefined;
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers,
    });
    const client = new Client({ name: 'paid-client', version: '1.0.0' });
    await client.connect(paidClientTransport);

    const originalOnMessage = paidClientTransport.onmessage;
    paidClientTransport.onmessage = (msg) => {
      observedPaymentPmi ??= capturePaymentRequiredPmi(msg);
      originalOnMessage?.(msg);
    };

    await client.callTool({
      name: 'add',
      arguments: { a: 1, b: 2 },
    });

    expect(observedPaymentPmi).toBe('pmi:B');

    await client.close();
    await mcpServer.close();
  }, 20000);

  test('idempotency: duplicate request event id does not double-charge', async () => {
    const processor = new FakePaymentProcessor({ verifyDelayMs: 1 });
    let verifyCalls = 0;
    let createCalls = 0;
    const originalCreate = processor.createPaymentRequired.bind(processor);
    const originalVerify = processor.verifyPayment.bind(processor);
    processor.createPaymentRequired = async (params) => {
      createCalls += 1;
      return await originalCreate(params);
    };
    processor.verifyPayment = async (params) => {
      verifyCalls += 1;
      return await originalVerify(params);
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    // Use the middleware directly to simulate duplicate delivery of the same request event id.
    let notificationsSent = 0;
    const sender = {
      async sendNotification(): Promise<void> {
        notificationsSent += 1;
      },
    };
    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'same-event-id',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    let forwarded = 0;
    const forward = async () => {
      forwarded += 1;
    };

    await Promise.all([mw(message, ctx, forward), mw(message, ctx, forward)]);

    expect(createCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(forwarded).toBe(1);
    expect(notificationsSent).toBeGreaterThanOrEqual(1);
  }, 20000);

  test('emits payment_accepted correlated to request id after verify and before forward', async () => {
    const events: string[] = [];
    const processor: PaymentProcessor = {
      pmi: 'fake',
      async createPaymentRequired(params) {
        events.push('create');
        return {
          amount: params.amount,
          pay_req: 'fake-invoice',
          description: params.description,
          pmi: 'fake',
        };
      },
      async verifyPayment() {
        events.push('verify:start');
        await new Promise((r) => setTimeout(r, 10));
        events.push('verify:end');
        return { _meta: { settled: true } };
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    const notifications: Array<{ method: string; correlatedEventId: string }> =
      [];
    const sender = {
      async sendNotification(
        _clientPubkey: string,
        notification: JSONRPCMessage,
        correlatedEventId: string,
      ): Promise<void> {
        if (!('method' in notification)) {
          throw new Error('Expected notification to have method');
        }
        notifications.push({
          method: String(notification.method),
          correlatedEventId,
        });
        events.push(`notify:${String(notification.method)}`);
      },
    };

    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'req-123',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    const forward = async (): Promise<void> => {
      events.push('forward');
    };

    await mw(message, ctx, forward);

    expect(notifications.map((n) => [n.method, n.correlatedEventId])).toEqual([
      ['notifications/payment_required', 'req-123'],
      ['notifications/payment_accepted', 'req-123'],
    ]);

    expect(events).toEqual([
      'create',
      'notify:notifications/payment_required',
      'verify:start',
      'verify:end',
      'notify:notifications/payment_accepted',
      'forward',
    ]);
  });

  test('fail-closed: createPaymentRequired throwing prevents forwarding', async () => {
    const processor: PaymentProcessor = {
      pmi: 'fake',
      async createPaymentRequired(): Promise<never> {
        throw new Error('create failed');
      },
      async verifyPayment() {
        return { _meta: { settled: true } };
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    let forwarded = 0;
    const sender = {
      async sendNotification(): Promise<void> {
        // no-op
      },
    };
    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'req-create-fail',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    const forward = async (): Promise<void> => {
      forwarded += 1;
    };

    expect(mw(message, ctx, forward)).rejects.toThrow(/create failed/);
    expect(forwarded).toBe(0);
  });

  test('fail-closed: verifyPayment rejecting prevents forwarding', async () => {
    const processor: PaymentProcessor = {
      pmi: 'fake',
      async createPaymentRequired(params) {
        return {
          amount: params.amount,
          pay_req: 'fake-invoice',
          description: params.description,
          pmi: 'fake',
        };
      },
      async verifyPayment(): Promise<never> {
        throw new Error('verify failed');
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    let forwarded = 0;
    let acceptedSent = 0;
    const sender = {
      async sendNotification(
        _clientPubkey: string,
        notification: JSONRPCMessage,
      ): Promise<void> {
        if (
          'method' in notification &&
          notification.method === 'notifications/payment_accepted'
        ) {
          acceptedSent += 1;
        }
      },
    };

    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'req-verify-fail',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    const forward = async (): Promise<void> => {
      forwarded += 1;
    };

    await expect(mw(message, ctx, forward)).rejects.toThrow(/verify failed/);
    expect(forwarded).toBe(0);
    expect(acceptedSent).toBe(0);
  });

  test('verification timeout clears pending state (ttl-based)', async () => {
    const processor: PaymentProcessor = {
      pmi: 'fake',
      async createPaymentRequired(params) {
        return {
          amount: params.amount,
          pay_req: `fake:${params.requestEventId}:${params.clientPubkey}:${params.amount}`,
          description: params.description,
          pmi: 'fake',
          ttl: 1,
        };
      },
      async verifyPayment() {
        return await new Promise(() => {
          // never resolves
        });
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    const sender = {
      async sendNotification(): Promise<void> {
        // no-op
      },
    };
    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'same-event-id-timeout',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    let forwarded = 0;
    const forward = async () => {
      forwarded += 1;
    };

    const startedAt = Date.now();
    await expect(mw(message, ctx, forward)).rejects.toThrow(
      /verifyPayment timed out/,
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
    expect(forwarded).toBe(0);

    // Retry should not be black-holed: it should attempt again and time out again.
    await expect(mw(message, ctx, forward)).rejects.toThrow(
      /verifyPayment timed out/,
    );
  }, 20000);

  test('client respects payment TTL without timing out even when TTL > MCP timeout (immediate-heartbeat regression)', async () => {
    // Scenario (local relay round-trips ≈ 15 ms each):
    //
    //   t=0     callTool → MCP timeout starts (400 ms)
    //   t≈215ms server finishes createPaymentRequired (createDelayMs=200)
    //             → sends payment_required{ttl:30}
    //   t≈230ms client receives payment_required
    //             → immediate synthetic heartbeat resets MCP timeout by 400 ms
    //               → new deadline: t ≈ 630 ms
    //             → FakePaymentHandler starts (delayMs=150)
    //   t≈380ms handler done; server begins verifyPayment (verifyDelayMs=150)
    //   t≈530ms verification done; server sends tool response
    //   t≈545ms client receives response — before 630 ms deadline ✓
    //
    // Without the immediate-heartbeat fix the only reset mechanism is the
    // periodic interval. With syntheticProgressIntervalMs=5_000 (>> 400 ms
    // timeout) the first interval tick fires at t ≈ 5230 ms — long after the
    // timeout fires at t=400 ms. The request would be cancelled with
    // "Request timed out" before the response can arrive.
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'paid-server-ttl',
      version: '1.0.0',
    });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    // TTL=30s >> MCP timeout=400ms: client must honour the TTL by keeping the
    // request alive via synthetic progress until payment settles.
    // createDelayMs simulates a slow server-side price oracle so that
    // payment_required arrives at the client AFTER ~230 ms, pushing total
    // processing time (≈ 545 ms) past the raw 400 ms MCP timeout.
    const processor = new FakePaymentProcessor({
      verifyDelayMs: 150,
      createDelayMs: 200,
      ttl: 30,
    });
    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'test payment',
      },
    ] as const;

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
      },
    );

    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);

    // syntheticProgressIntervalMs (5 s) >> MCP timeout (400 ms): the interval
    // alone can never fire in time. Only the immediate heartbeat (the fix) can
    // prevent the timeout, proving that is what saves the request.
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [new FakePaymentHandler({ delayMs: 150 })],
      syntheticProgressIntervalMs: 5_000,
    });

    const client = new Client({ name: 'paid-client-ttl', version: '1.0.0' });
    await client.connect(paidClientTransport);

    const result = await client.callTool(
      { name: 'add', arguments: { a: 3, b: 4 } },
      undefined,
      {
        // Short timeout: processing (≈545 ms) exceeds this without a reset.
        timeout: 400,
        // Opt in to MCP progress-based timeout resetting.
        onprogress: () => {},
        resetTimeoutOnProgress: true,
      },
    );

    const typedResult = result as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(typedResult.content[0]).toMatchObject({ type: 'text', text: '7' });

    await client.close();
    await mcpServer.close();
  }, 20000);
});
