import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { sleep, type Subprocess } from 'bun';
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
  createClientPmiOutboundTagHook,
  createServerPaymentsMiddleware,
  withClientPayments,
  withServerPayments,
} from '../payments/index.js';

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

const baseRelayPort = 7810;
const relayUrl = `ws://localhost:${baseRelayPort}`;

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

describe('payments fake flow (transport-level)', () => {
  let relayProcess: Subprocess;

  beforeAll(async () => {
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${baseRelayPort}`,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await sleep(100);
  });

  afterEach(async () => {
    try {
      const clearUrl = relayUrl.replace('ws://', 'http://') + '/clear-cache';
      await fetch(clearUrl, { method: 'POST' });
    } catch {
      // best-effort
    }
  });

  afterAll(async () => {
    relayProcess?.kill();
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
      outboundTagHook: createClientPmiOutboundTagHook(handlers),
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
      outboundTagHook: createClientPmiOutboundTagHook(handlers),
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
      outboundTagHook: createClientPmiOutboundTagHook(handlers),
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
    const originalVerify = processor.verifyPayment.bind(processor);
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

    expect(verifyCalls).toBe(1);
    expect(forwarded).toBe(1);
    expect(notificationsSent).toBeGreaterThanOrEqual(1);
  }, 20000);
});
