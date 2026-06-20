import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  spyOn,
} from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';
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
  rejectPrice,
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

    await expect(mw(message, ctx, forward)).rejects.toThrow(/create failed/);
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

  test('explicit gating: gates tools/call via -32042 error and auto-retries', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'explicit-server',
      version: '1.0.0',
    });
    let toolCallCount = 0;
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        toolCallCount++;
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    const processor = new FakePaymentProcessor({ verifyDelayMs: 20 });
    const createSpy = spyOn(processor, 'createPaymentRequired');
    const verifySpy = spyOn(processor, 'verifyPayment');
    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'explicit test payment',
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
        paymentInteraction: 'explicit_gating',
      },
    );

    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);

    // Track if onPaymentRequired was called
    let explicitPaymentHandled = false;

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => {
        explicitPaymentHandled = true;
        return { paid: true };
      },
    });

    const client = new Client({ name: 'explicit-client', version: '1.0.0' });
    await client.connect(paidClientTransport);

    const result = await client.callTool({
      name: 'add',
      arguments: { a: 10, b: 20 },
    });

    const typedResult = result as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(typedResult.content[0]).toMatchObject({ type: 'text', text: '30' });

    expect(explicitPaymentHandled).toBe(true);
    expect(toolCallCount).toBe(1);
    expect(createSpy).toHaveBeenCalled();
    expect(verifySpy).toHaveBeenCalled();

    await client.close();
    await mcpServer.close();
  }, 20000);

  // CEP-8 MUST: server indicates the effective mode on its first direct response.
  test('explicit gating: server discloses payment_interaction=explicit_gating on first direct response', async () => {
    const serverSK = generateSecretKey();
    const serverPublicKey = getPublicKey(serverSK);
    const serverPrivateKey = bytesToHex(serverSK);

    const mcpServer = new McpServer({
      name: 'disclosure-server',
      version: '1.0.0',
    });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    const processor = new FakePaymentProcessor();
    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
        paymentInteraction: 'explicit_gating',
      },
    );
    await mcpServer.connect(serverTransport);

    // Capture the server's first published CTXVM event carrying a payment_interaction tag.
    const capturePromise = captureNextCtxvmEvent({
      relayUrl,
      authors: [serverPublicKey],
      where: (event) =>
        event.tags.some(
          (t) => t[0] === 'payment_interaction' && typeof t[1] === 'string',
        ),
      timeoutMs: 5000,
    });

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => ({ paid: true }),
    });

    const client = new Client({
      name: 'disclosure-client',
      version: '1.0.0',
    });
    await client.connect(paidClientTransport); // triggers initialize → first response

    const event = await capturePromise;
    const piTag = event.tags.find((t) => t[0] === 'payment_interaction') as
      | readonly string[]
      | undefined;
    expect(piTag?.[1]).toBe('explicit_gating');

    await client.close();
    await mcpServer.close();
  }, 20000);

  // Locks the pending race: pay → slow verify → -32043 → backoff → grant → success.
  test('explicit gating: -32043 pending race resolves after verify completes', async () => {
    const serverSK = generateSecretKey();
    const serverPublicKey = getPublicKey(serverSK);
    const serverPrivateKey = bytesToHex(serverSK);

    const mcpServer = new McpServer({
      name: 'pending-race-server',
      version: '1.0.0',
    });
    let toolCallCount = 0;
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        toolCallCount++;
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    // verifyDelayMs >> relay round-trip, so the client's first retry arrives
    // while verification is still pending (→ -32043). Default grant TTL (5 min)
    // keeps retry_after at 2 s; verification completes well before the backoff.
    const processor = new FakePaymentProcessor({ verifyDelayMs: 500 });
    const createSpy = spyOn(processor, 'createPaymentRequired');
    const verifySpy = spyOn(processor, 'verifyPayment');

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
        paymentInteraction: 'explicit_gating',
      },
    );
    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => ({ paid: true }),
    });

    const client = new Client({
      name: 'pending-race-client',
      version: '1.0.0',
    });
    await client.connect(paidClientTransport);

    const result = await client.callTool({
      name: 'add',
      arguments: { a: 5, b: 7 },
    });

    const typedResult = result as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(typedResult.content[0]).toMatchObject({ type: 'text', text: '12' });

    // Despite the request being sent multiple times (initial + retry-after-pay +
    // retry-after-32043), exactly one payment was created and one verification ran.
    // This is the core anti-double-charge invariant of the explicit-gating flow.
    expect(toolCallCount).toBe(1);
    expect(createSpy.mock.calls.length).toBe(1);
    expect(verifySpy.mock.calls.length).toBe(1);

    await client.close();
    await mcpServer.close();
  }, 25000);

  // User declines to pay: the wrapper synthesizes -32042 with the given reason
  // and does not retry. Locks the { paid: false } contract end-to-end.
  test('explicit gating: user-declined payment surfaces -32042 and does not retry', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'decline-server',
      version: '1.0.0',
    });
    let toolCallCount = 0;
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        toolCallCount++;
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    const processor = new FakePaymentProcessor();
    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
        paymentInteraction: 'explicit_gating',
      },
    );
    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => ({
        paid: false,
        reason: 'user_cancelled',
      }),
    });

    const client = new Client({ name: 'decline-client', version: '1.0.0' });
    await client.connect(paidClientTransport);

    await expect(
      client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }),
    ).rejects.toMatchObject({
      code: -32042,
      data: { reason: 'user_cancelled' },
    });

    expect(toolCallCount).toBe(0);

    await client.close();
    await mcpServer.close();
  }, 20000);

  // onPaymentRequired rejects: the wrapper synthesizes -32042 with
  // data.type = 'payment_handler_error' and surfaces it to the caller.
  test('explicit gating: onPaymentRequired throwing surfaces -32042 with type payment_handler_error', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'handler-error-server',
      version: '1.0.0',
    });
    let toolCallCount = 0;
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        toolCallCount++;
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    const processor = new FakePaymentProcessor();
    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
        paymentInteraction: 'explicit_gating',
      },
    );
    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => {
        throw new Error('wallet offline');
      },
    });

    const client = new Client({
      name: 'handler-error-client',
      version: '1.0.0',
    });
    await client.connect(paidClientTransport);

    await expect(
      client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }),
    ).rejects.toMatchObject({
      code: -32042,
      data: { reason: 'wallet offline', type: 'payment_handler_error' },
    });

    expect(toolCallCount).toBe(0);

    await client.close();
    await mcpServer.close();
  }, 20000);

  // Verify-failure window: when verification fails after the client paid, the
  // server clears pending state and the next retry yields a FRESH invoice
  // (distinct pay_req). The client pays twice; the tool runs exactly once.
  // Locks wire-level correlation across the verify-failure branch (the double-
  // charge window documented on onPaymentRequired).
  test('explicit gating: verifyPayment failure yields a fresh invoice on retry', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'fresh-invoice-server',
      version: '1.0.0',
    });
    let toolCallCount = 0;
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        toolCallCount++;
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    const issuedPayReqs: string[] = [];
    let verifyCount = 0;
    const processor: PaymentProcessor = {
      pmi: 'fake',
      async createPaymentRequired(params) {
        const pay_req = `pr-${issuedPayReqs.length + 1}`;
        issuedPayReqs.push(pay_req);
        return {
          amount: params.amount,
          pay_req,
          description: params.description,
          pmi: 'fake',
          ttl: 300,
        };
      },
      async verifyPayment() {
        verifyCount += 1;
        if (verifyCount === 1) {
          throw new Error('settlement failed');
        }
        return { _meta: { settled: true } };
      },
    };

    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
        paymentInteraction: 'explicit_gating',
      },
    );
    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    // Client pays unconditionally, so both invoices get paid.
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => ({ paid: true }),
    });

    const client = new Client({
      name: 'fresh-invoice-client',
      version: '1.0.0',
    });
    await client.connect(paidClientTransport);

    const result = await client.callTool({
      name: 'add',
      arguments: { a: 5, b: 7 },
    });
    const typedResult = result as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(typedResult.content[0]).toMatchObject({ type: 'text', text: '12' });

    // Two distinct invoices issued; verify ran twice; the tool ran exactly once.
    expect(issuedPayReqs).toHaveLength(2);
    expect(issuedPayReqs[0]).not.toBe(issuedPayReqs[1]);
    expect(verifyCount).toBe(2);
    expect(toolCallCount).toBe(1);

    await client.close();
    await mcpServer.close();
  }, 25000);

  // CEP-8 negotiation: a client requesting explicit_gating against a transparent-
  // only server receives -32602 with the requested + supported modes. Locks the
  // effective-mode-disclosure MUST at the integration level.
  test('explicit gating: transparent-only server rejects initialize with -32602', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'transparent-only-server',
      version: '1.0.0',
    });
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    // No paymentInteraction option → transparent-only server.
    const processor = new FakePaymentProcessor();
    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
      },
    );
    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [],
      paymentInteraction: 'explicit_gating',
      onPaymentRequired: async () => ({ paid: true }),
    });

    const client = new Client({ name: 'negotiation-client', version: '1.0.0' });

    await expect(client.connect(paidClientTransport)).rejects.toMatchObject({
      code: -32602,
      data: { requested: 'explicit_gating', supported: ['transparent'] },
    });

    await mcpServer.close();
  }, 20000);

  // resolvePrice rejection: server emits payment_rejected instead of requesting
  // payment; the client synthesizes -32000 so the caller rejects immediately
  // instead of timing out. Locks the full transparent rejection path end-to-end.
  test('transparent: resolvePrice rejection surfaces -32000 to the caller', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'reject-server',
      version: '1.0.0',
    });
    let toolCallCount = 0;
    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => {
        toolCallCount++;
        return { content: [{ type: 'text', text: String(a + b) }] };
      },
    );

    const processor = new FakePaymentProcessor();
    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
        resolvePrice: async () => rejectPrice('Free quota exhausted'),
      },
    );
    await mcpServer.connect(serverTransport);

    const clientSK = generateSecretKey();
    const clientPrivateKey = bytesToHex(clientSK);
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    const paidClientTransport = withClientPayments(clientTransport, {
      handlers: [new FakePaymentHandler({ pmi: 'fake', delayMs: 1 })],
    });

    const client = new Client({ name: 'reject-client', version: '1.0.0' });
    await client.connect(paidClientTransport);

    await expect(
      client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }),
    ).rejects.toMatchObject({ code: -32000 });
    // McpError wraps the message as 'MCP error -32000: <original>'
    await expect(
      client.callTool({ name: 'add', arguments: { a: 3, b: 4 } }),
    ).rejects.toThrow('Free quota exhausted');

    expect(toolCallCount).toBe(0);

    await client.close();
    await mcpServer.close();
  }, 20000);
});
