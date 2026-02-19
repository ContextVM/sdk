import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
} from 'bun:test';
import { sleep, type Subprocess } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ListToolsResult,
  TextContent,
  ToolResultContent,
} from '@modelcontextprotocol/sdk/types.js';
import { EncryptionMode } from '../core/interfaces.js';
import { CTXVM_MESSAGES_KIND } from '../core/constants.js';
import { withServerPayments } from '../payments/server-transport-payments.js';
import { FakePaymentProcessor } from '../payments/fake-payment-processor.js';

const baseRelayPort = 7791;
const relayUrl = `ws://localhost:${baseRelayPort}`;

describe('NostrClientTransport', () => {
  let relayProcess: Subprocess;
  let server: McpServer;
  let serverTransport: NostrServerTransport;
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

  beforeAll(async () => {
    // Start mock relay
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: { ...process.env, PORT: `${baseRelayPort}` },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await sleep(200);

    server = new McpServer({
      name: 'Test-Server-For-Client-Test',
      version: '1.0.0',
    });

    server.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    // Create and connect server transport
    serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
    });
    await server.connect(serverTransport);
  });

  afterEach(async () => {
    // Clear relay cache
    try {
      const clearUrl = relayUrl.replace('ws://', 'http://') + '/clear-cache';
      await fetch(clearUrl, { method: 'POST' });
    } catch (error) {
      console.warn('[TEST] Failed to clear event cache:', error);
    }
  });

  afterAll(async () => {
    await server.close();
    relayProcess?.kill();
    await sleep(100);
  });

  test('should connect and list tools in stateless mode', async () => {
    // Create a client
    const client = new Client({ name: 'Stateless-Client', version: '1.0.0' });
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      isStateless: true, // Enable stateless mode
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);

    const receivedEvents: NostrEvent[] = [];
    clientTransport['relayHandler'].subscribe([{}], (event) => {
      receivedEvents.push(event);
    });

    const tools: ListToolsResult = await client.listTools();
    await sleep(100);
    // Assertions
    expect(tools).toBeDefined();
    expect(Array.isArray(tools.tools)).toBe(true);
    expect(tools.tools.length).toBe(1);
    expect(receivedEvents.length).toBe(2);
    await client.close();
  }, 10000);

  test('should handle server restart and continue processing requests', async () => {
    // Create a client
    const client = new Client({
      name: 'Reconnection-Client',
      version: '1.0.0',
    });
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);

    // First request - should work
    const tools1 = await client.listTools();
    expect(tools1).toBeDefined();
    expect(Array.isArray(tools1.tools)).toBe(true);

    // Simulate server restart by closing and recreating server
    await server.close();

    // Create new server with same keys
    const newServer = new McpServer({
      name: 'Test-Server-Restarted',
      version: '1.0.0',
    });

    newServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    const newServerTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
    });

    await newServer.connect(newServerTransport);

    // Wait a bit for reconnection to stabilize
    await sleep(500);

    // Second request after server restart - should still work
    const tools2 = await client.listTools();
    expect(tools2).toBeDefined();
    expect(Array.isArray(tools2.tools)).toBe(true);
    expect(tools2.tools.length).toBe(1);

    // Test tool call after restart
    const toolResult = await client.callTool({
      name: 'add',
      arguments: { a: 5, b: 3 },
    });
    expect(toolResult).toBeDefined();
    const { text } = (toolResult as ToolResultContent)
      .content[0] as TextContent;
    expect(text).toBe('8');

    await client.close();
    await newServer.close();
  }, 15000);

  test('should route correlated notifications (with e tag) as notifications even when e is unknown', async () => {
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    const received: unknown[] = [];
    clientTransport.onmessage = (msg) => {
      received.push(msg);
    };

    await clientTransport.start();

    // Publish a notification event from the server, but include an `e` tag that does not
    // correspond to any pending request. This must still be delivered as a notification.
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
      params: {
        amount: 1,
        pay_req: 'test-pay-req',
        pmi: 'test-pmi',
      },
    } as const;

    const unsignedEvent = {
      kind: CTXVM_MESSAGES_KIND,
      content: JSON.stringify(notification),
      created_at: Math.floor(Date.now() / 1000),
      pubkey: serverPublicKey,
      tags: [
        ['p', clientPublicKey],
        ['e', '0'.repeat(64)],
      ],
    };

    // Sign with the server private key so it matches serverPubkey filter.
    const signedEvent = await new PrivateKeySigner(serverPrivateKey).signEvent(
      unsignedEvent,
    );
    await clientTransport['relayHandler'].publish(signedEvent);

    await sleep(150);

    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/payment_required',
    });

    await clientTransport.close();
  }, 10000);

  test('should route uncorrelated notifications (without e tag) as notifications', async () => {
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    const received: unknown[] = [];
    clientTransport.onmessage = (msg) => {
      received.push(msg);
    };

    await clientTransport.start();

    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: {},
    } as const;

    const unsignedEvent = {
      kind: CTXVM_MESSAGES_KIND,
      content: JSON.stringify(notification),
      created_at: Math.floor(Date.now() / 1000),
      pubkey: serverPublicKey,
      tags: [['p', clientPublicKey]],
    };

    const signedEvent = await new PrivateKeySigner(serverPrivateKey).signEvent(
      unsignedEvent,
    );
    await clientTransport['relayHandler'].publish(signedEvent);

    await sleep(150);

    expect(received.length).toBe(1);
    expect(received[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });

    await clientTransport.close();
  }, 10000);

  test('captures tools/list response envelope so consumers can access cap tags', async () => {
    // Recreate a server transport with payments enabled so the tools/list response includes cap tags.
    await server.close();

    const paidServer = new McpServer({ name: 'Paid-Server', version: '1.0.0' });
    paidServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    const paidServerTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
    });

    withServerPayments(paidServerTransport, {
      processors: [
        new FakePaymentProcessor({ pmi: 'pmi:test', verifyDelayMs: 1 }),
      ],
      pricedCapabilities: [
        {
          method: 'tools/call',
          name: 'add',
          amount: 123,
          currencyUnit: 'sats',
        },
      ],
    });

    await paidServer.connect(paidServerTransport);

    const client = new Client({ name: 'Client', version: '1.0.0' });
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);

    await client.listTools();

    // Allow async event processing to populate cached envelope.
    await sleep(150);

    const toolsListEvent = clientTransport.getServerToolsListEvent();
    expect(toolsListEvent).toBeDefined();

    // Ensure CEP-8 cap tags are available on the outer Nostr envelope.
    const capTags = toolsListEvent!.tags.filter((t) => t[0] === 'cap');
    expect(capTags).toEqual(
      expect.arrayContaining([['cap', 'tool:add', '123', 'sats']]),
    );

    await client.close();
    await paidServer.close();
  }, 20000);
});

describe('NostrClientTransport instance shape', () => {
  test('onmessageWithContext is an own instance property (regression: ES2018 field without initialiser is not an own property)', () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'a'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: [],
    });
    expect('onmessageWithContext' in transport).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(transport, 'onmessageWithContext'),
    ).toBe(true);
  });
});
