import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
} from 'bun:test';
import { sleep } from 'bun';
import type { MockRelayInstance } from '../__mocks__/mock-relay-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  InitializeResult,
  ListToolsResult,
  TextContent,
  ToolResultContent,
} from '@modelcontextprotocol/sdk/types.js';
import { EncryptionMode } from '../core/interfaces.js';
import {
  CTXVM_MESSAGES_KIND,
  DEFAULT_BOOTSTRAP_RELAY_URLS,
  NOSTR_TAGS,
} from '../core/constants.js';
import { withServerPayments } from '../payments/server-transport-payments.js';
import { FakePaymentProcessor } from '../payments/fake-payment-processor.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { waitFor } from '../core/utils/test.utils.js';
import { buildOpenStreamPingFrame } from './open-stream/frames.js';

class InspectableNostrClientTransport extends NostrClientTransport {
  public async measureOutboundSizeForTesting(
    message: JSONRPCMessage,
    includeDiscovery: boolean = true,
  ): Promise<number> {
    return this.measurePublishedMcpMessageSize(
      message,
      this['serverPubkey'],
      CTXVM_MESSAGES_KIND,
      this['buildOutboundClientTags']({
        baseTags: this['createRecipientTags'](this['serverPubkey']),
        includeDiscovery,
      }),
      undefined,
      this['chooseOutboundGiftWrapKind'](),
    );
  }

  public async resolveChunkSizeForTesting(params: {
    desiredChunkSizeBytes: number;
    thresholdBytes: number;
    progressToken: string;
  }): Promise<number> {
    return this.resolveSafeOversizedChunkSize({
      desiredChunkSizeBytes: params.desiredChunkSizeBytes,
      maxPublishedEventBytes: params.thresholdBytes,
      recipientPublicKey: this['serverPubkey'],
      kind: CTXVM_MESSAGES_KIND,
      progressToken: params.progressToken,
      progress: 2,
      tags: this['createRecipientTags'](this['serverPubkey']),
      giftWrapKind: this['chooseOutboundGiftWrapKind'](),
    });
  }
}

describe.serial('NostrClientTransport', () => {
  let relay: MockRelayInstance;
  let relayUrl: string;
  let httpUrl: string;
  let server: McpServer;
  let serverTransport: NostrServerTransport;
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

  beforeAll(async () => {
    // Start mock relay with dynamic port
    const spawned = await spawnMockRelay();
    relay = spawned.relay;
    relayUrl = spawned.relayUrl;
    httpUrl = spawned.httpUrl;

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
    await clearRelayCache(httpUrl);
  });

  afterAll(async () => {
    await server.close();
    relay.stop();
    await sleep(100);
  });

  test('measures final published event size above logical JSON-RPC size', async () => {
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const clientTransport = new InspectableNostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
      isStateless: true,
    });

    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'add',
        arguments: { a: 1, b: 2 },
        _meta: { progressToken: 'size-check' },
      },
    };

    const logicalSize = new TextEncoder().encode(
      JSON.stringify(message),
    ).byteLength;
    const publishedSize =
      await clientTransport.measureOutboundSizeForTesting(message);

    expect(publishedSize).toBeGreaterThan(logicalSize);
  });

  test('derives a chunk size that fits within the published event threshold', async () => {
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const clientTransport = new InspectableNostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    const desiredChunkSizeBytes = 512;
    const desiredFrame: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'chunk-check',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'chunk',
          data: '\\'.repeat(desiredChunkSizeBytes),
        },
      },
    };
    const desiredMeasured = await clientTransport.measureOutboundSizeForTesting(
      desiredFrame,
      false,
    );
    const thresholdBytes = desiredMeasured - 100;

    const chunkSizeBytes = await clientTransport.resolveChunkSizeForTesting({
      desiredChunkSizeBytes,
      thresholdBytes,
      progressToken: 'chunk-check',
    });

    const candidateFrame: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'chunk-check',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'chunk',
          data: '\\'.repeat(chunkSizeBytes),
        },
      },
    };

    const measured = await clientTransport.measureOutboundSizeForTesting(
      candidateFrame,
      false,
    );

    expect(chunkSizeBytes).toBeGreaterThan(0);
    expect(chunkSizeBytes).toBeLessThan(desiredChunkSizeBytes);
    expect(measured).toBeLessThanOrEqual(thresholdBytes);
  });

  test('should connect and list tools in stateless mode', async () => {
    // Create a client
    const client = new Client({ name: 'Stateless-Client', version: '1.0.0' });
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      isStateless: true, // Enable stateless mode
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);

    const hasTagValue = (
      event: NostrEvent,
      name: string,
      value: string,
    ): boolean => event.tags.some((t) => t[0] === name && t[1] === value);

    const receivedEvents: NostrEvent[] = [];
    const receivedTwoEvents = new Promise<void>((resolve, reject) => {
      let unsubscribe: (() => void) | null = null;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for 2 relay events'));
      }, 5000);

      const cleanup = (): void => {
        clearTimeout(timeout);
        try {
          unsubscribe?.();
        } catch {
          // Best-effort: test isolation only
        }
      };

      void clientTransport['relayHandler']
        .subscribe([{}], (event) => {
          const isRequest =
            event.pubkey === clientPublicKey &&
            hasTagValue(event, 'p', serverPublicKey);
          const isResponse =
            event.pubkey === serverPublicKey &&
            hasTagValue(event, 'p', clientPublicKey);

          if (!isRequest && !isResponse) return;

          receivedEvents.push(event);
          if (receivedEvents.length >= 2) {
            cleanup();
            resolve();
          }
        })
        .then((u) => {
          unsubscribe = u;
        })
        .catch(() => {
          // Ignore subscribe errors; listTools() will fail if relay is broken.
        });
    });

    const tools: ListToolsResult = await client.listTools();

    await receivedTwoEvents;

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

  test.serial(
    'should expose minimal initialize event convenience accessors',
    async () => {
      await server.close();

      const metadataServer = new McpServer({
        name: 'Metadata Server',
        version: '1.0.0',
      });

      const metadataServerTransport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverInfo: {
          name: 'Metadata Server',
          about: 'Server metadata for initialize tags',
          website: 'https://example.com',
          picture: 'https://example.com/logo.png',
        },
        encryptionMode: EncryptionMode.OPTIONAL,
      });

      await metadataServer.connect(metadataServerTransport);

      const client = new Client({
        name: 'Metadata Client',
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
      await sleep(200);

      const initializeEvent = clientTransport.getServerInitializeEvent();
      expect(initializeEvent).toBeDefined();
      expect(
        initializeEvent!.tags.some(
          (tag) => tag.length === 1 && tag[0] === NOSTR_TAGS.SUPPORT_ENCRYPTION,
        ),
      ).toBe(true);

      const initializeResult = clientTransport.getServerInitializeResult();
      expect(initializeResult).toBeDefined();
      expect((initializeResult as InitializeResult).serverInfo.name).toBe(
        'Metadata Server',
      );
      expect(clientTransport.serverSupportsEncryption()).toBe(true);
      expect(clientTransport.serverSupportsEphemeralEncryption()).toBe(true);
      expect(clientTransport.getServerInitializeName()).toBe('Metadata Server');
      expect(clientTransport.getServerInitializeAbout()).toBe(
        'Server metadata for initialize tags',
      );
      expect(clientTransport.getServerInitializeWebsite()).toBe(
        'https://example.com',
      );
      expect(clientTransport.getServerInitializePicture()).toBe(
        'https://example.com/logo.png',
      );

      await client.close();
      await metadataServer.close();

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

      serverTransport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
      });
      await server.connect(serverTransport);
    },
    15000,
  );

  test('should drop correlated notifications (with e tag) when e is unknown', async () => {
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

    // Publish a notification event from the server with an `e` tag that does not
    // correspond to any pending request. It must be dropped.
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

    expect(received.length).toBe(0);

    await clientTransport.close();
  }, 10000);

  test('should route correlated notifications (with e tag) when e matches a pending request', async () => {
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

    const knownEventId = '1'.repeat(64);
    clientTransport
      .getInternalStateForTesting()
      .correlationStore.registerRequest(knownEventId, {
        originalRequestId: 'req-1',
        isInitialize: false,
      });

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
        ['e', knownEventId],
      ],
    };

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

  test('forwards open-stream progress notifications to the upstream transport handlers', async () => {
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    const received: unknown[] = [];
    const receivedWithContext: Array<{
      message: unknown;
      context: { eventId: string; correlatedEventId?: string };
    }> = [];

    clientTransport.onmessage = (msg) => {
      received.push(msg);
    };
    clientTransport.onmessageWithContext = (message, context) => {
      receivedWithContext.push({ message, context });
    };

    await clientTransport.start();

    const knownEventId = '2'.repeat(64);
    clientTransport
      .getInternalStateForTesting()
      .correlationStore.registerRequest(knownEventId, {
        originalRequestId: 2,
        isInitialize: false,
      });

    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: buildOpenStreamPingFrame({
        progressToken: '2',
        progress: 1,
        nonce: '2:1',
      }),
    } as const;

    const unsignedEvent = {
      kind: CTXVM_MESSAGES_KIND,
      content: JSON.stringify(notification),
      created_at: Math.floor(Date.now() / 1000),
      pubkey: serverPublicKey,
      tags: [
        ['p', clientPublicKey],
        ['e', knownEventId],
      ],
    };

    const signedEvent = await new PrivateKeySigner(serverPrivateKey).signEvent(
      unsignedEvent,
    );
    await clientTransport['relayHandler'].publish(signedEvent);

    await waitFor({
      produce: () => {
        return received.length === 1 && receivedWithContext.length === 1
          ? true
          : undefined;
      },
      timeoutMs: 5_000,
    });

    expect(received).toEqual([notification]);
    expect(receivedWithContext).toEqual([
      {
        message: notification,
        context: {
          eventId: signedEvent.id,
          correlatedEventId: knownEventId,
        },
      },
    ]);

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
    const paidServer = new McpServer({ name: 'Paid-Server', version: '1.0.0' });
    const relayHub = new MockRelayHub();
    const paidServerPrivateKey = bytesToHex(generateSecretKey());
    const paidServerPublicKey = getPublicKey(hexToBytes(paidServerPrivateKey));
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
      signer: new PrivateKeySigner(paidServerPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
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
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: paidServerPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);

    await client.listTools();

    const toolsListEvent = await waitFor({
      produce: () => clientTransport.getServerToolsListEvent(),
      predicate: (event) => event.tags.some((t) => t[0] === 'cap'),
      timeoutMs: 5_000,
    });

    // Ensure CEP-8 cap tags are available on the outer Nostr envelope.
    const capTags = toolsListEvent.tags.filter((t) => t[0] === 'cap');
    expect(capTags).toEqual(
      expect.arrayContaining([['cap', 'tool:add', '123', 'sats']]),
    );
    expect(
      clientTransport
        .getServerInitializeEvent()
        ?.tags.some((t) => t[0] === 'cap'),
    ).toBe(false);

    await client.close();
    await paidServer.close();
    relayHub.clear();
  }, 20000);

  test('keeps later tools/list cap tags out of the learned baseline event', async () => {
    const paidServer = new McpServer({ name: 'Paid-Server', version: '1.0.0' });
    const relayHub = new MockRelayHub();
    const paidServerPrivateKey = bytesToHex(generateSecretKey());
    const paidServerPublicKey = getPublicKey(hexToBytes(paidServerPrivateKey));

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
      signer: new PrivateKeySigner(paidServerPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      serverInfo: {
        name: 'Paid-Server',
        about: 'Baseline metadata',
      },
      encryptionMode: EncryptionMode.OPTIONAL,
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
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: paidServerPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);
    const baselineBeforeList = clientTransport.getServerInitializeEvent();
    expect(baselineBeforeList).toBeDefined();
    expect(clientTransport.getServerInitializeResult()).toBeDefined();

    await client.listTools();

    const toolsListEvent = await waitFor({
      produce: () => clientTransport.getServerToolsListEvent(),
      predicate: (event) => event.tags.some((t) => t[0] === 'cap'),
      timeoutMs: 5_000,
    });

    const baselineEvent = clientTransport.getServerInitializeEvent();
    expect(baselineEvent).toBeDefined();
    expect(toolsListEvent.tags).toEqual(
      expect.arrayContaining([['cap', 'tool:add', '123', 'sats']]),
    );
    expect(baselineEvent!.tags).not.toEqual(
      expect.arrayContaining([['cap', 'tool:add', '123', 'sats']]),
    );
    expect(baselineEvent).toEqual(baselineBeforeList);
    expect(clientTransport.getServerInitializeName()).toBe('Paid-Server');
    expect(clientTransport.getServerInitializeAbout()).toBe(
      'Baseline metadata',
    );

    await client.close();
    await paidServer.close();
    relayHub.clear();
  }, 20000);

  test('preserves initialize baseline metadata after later tools/list responses', async () => {
    const paidServer = new McpServer({
      name: 'Preserved Baseline Server',
      version: '1.0.0',
    });
    const relayHub = new MockRelayHub();
    const paidServerPrivateKey = bytesToHex(generateSecretKey());
    const paidServerPublicKey = getPublicKey(hexToBytes(paidServerPrivateKey));

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
      signer: new PrivateKeySigner(paidServerPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      serverInfo: {
        name: 'Preserved Baseline Server',
        about: 'Initialize baseline metadata',
        website: 'https://example.com/preserved',
      },
      encryptionMode: EncryptionMode.OPTIONAL,
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
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: paidServerPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);

    const baselineBeforeList = clientTransport.getServerInitializeEvent();
    expect(baselineBeforeList).toBeDefined();
    expect(clientTransport.getServerInitializeName()).toBe(
      'Preserved Baseline Server',
    );
    expect(clientTransport.getServerInitializeAbout()).toBe(
      'Initialize baseline metadata',
    );
    expect(clientTransport.getServerInitializeWebsite()).toBe(
      'https://example.com/preserved',
    );

    await client.listTools();

    await waitFor({
      produce: () => clientTransport.getServerToolsListEvent(),
      predicate: (event) => event.tags.some((t) => t[0] === 'cap'),
      timeoutMs: 5_000,
    });

    const baselineAfterList = clientTransport.getServerInitializeEvent();
    expect(baselineAfterList).toEqual(baselineBeforeList);
    expect(clientTransport.getServerInitializeName()).toBe(
      'Preserved Baseline Server',
    );
    expect(clientTransport.getServerInitializeAbout()).toBe(
      'Initialize baseline metadata',
    );
    expect(clientTransport.getServerInitializeWebsite()).toBe(
      'https://example.com/preserved',
    );

    await client.close();
    await paidServer.close();
    relayHub.clear();
  }, 20000);

  test('learns discovery tags from first stateless server response', async () => {
    await server.close();

    const statelessServer = new McpServer({
      name: 'Stateless Discovery Server',
      version: '1.0.0',
    });
    statelessServer.registerTool(
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

    const statelessServerTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverInfo: {
        name: 'Stateless Discovery Server',
        about: 'Learns metadata from first response',
        website: 'https://example.com/stateless',
        picture: 'https://example.com/stateless.png',
      },
      encryptionMode: EncryptionMode.OPTIONAL,
    });
    statelessServerTransport.setAnnouncementExtraTags([
      ['custom_discovery', 'supported'],
    ]);

    await statelessServer.connect(statelessServerTransport);

    const client = new Client({ name: 'Stateless-Client', version: '1.0.0' });
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      isStateless: true,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(clientTransport);
    await client.listTools();
    await sleep(150);

    const learnedEvent = clientTransport.getServerInitializeEvent();
    expect(learnedEvent).toBeDefined();
    expect(clientTransport.getServerInitializeName()).toBe(
      'Stateless Discovery Server',
    );
    expect(clientTransport.getServerInitializeAbout()).toBe(
      'Learns metadata from first response',
    );
    expect(clientTransport.getServerInitializeWebsite()).toBe(
      'https://example.com/stateless',
    );
    expect(clientTransport.getServerInitializePicture()).toBe(
      'https://example.com/stateless.png',
    );
    expect(clientTransport.serverSupportsEncryption()).toBe(true);
    expect(learnedEvent!.tags).toEqual(
      expect.arrayContaining([
        [NOSTR_TAGS.NAME, 'Stateless Discovery Server'],
        [NOSTR_TAGS.ABOUT, 'Learns metadata from first response'],
        [NOSTR_TAGS.WEBSITE, 'https://example.com/stateless'],
        [NOSTR_TAGS.PICTURE, 'https://example.com/stateless.png'],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL],
        [NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER],
        ['custom_discovery', 'supported'],
      ]),
    );
    expect(clientTransport.serverSupportsEphemeralEncryption()).toBe(true);

    await client.close();
    await statelessServer.close();
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

  test('accepts npub as serverPubkey input and normalizes it to hex', () => {
    const transport = new NostrClientTransport({
      serverPubkey: nip19.npubEncode('a'.repeat(64)),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: [],
    });

    expect(transport.getInternalStateForTesting().serverPubkey).toBe(
      'a'.repeat(64),
    );
  });

  test('accepts nprofile as serverPubkey input and normalizes it to hex', () => {
    const transport = new NostrClientTransport({
      serverPubkey: nip19.nprofileEncode({
        pubkey: 'b'.repeat(64),
        relays: ['wss://relay.example.com'],
      }),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: [],
    });

    expect(transport.getInternalStateForTesting().serverPubkey).toBe(
      'b'.repeat(64),
    );
  });

  test('throws a clear error for unsupported serverPubkey formats', () => {
    expect(
      () =>
        new NostrClientTransport({
          serverPubkey: 'not-a-valid-identifier',
          signer: new PrivateKeySigner('a'.repeat(64)),
          relayHandler: [],
        }),
    ).toThrow(
      'Invalid serverPubkey format: not-a-valid-identifier. Expected hex pubkey, npub, or nprofile.',
    );
  });

  test('uses nprofile relay hints when no operational relays are configured', async () => {
    const relayHintUrl = 'wss://relay.example.com';
    const transport = new NostrClientTransport({
      serverPubkey: nip19.nprofileEncode({
        pubkey: 'b'.repeat(64),
        relays: [relayHintUrl],
      }),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: [],
    });

    await transport['resolveOperationalRelayHandler']();

    expect(transport.getInternalStateForTesting().relayUrls).toEqual([
      relayHintUrl,
    ]);
  });

  test('uses bootstrap discovery relays by default when none are provided', () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
    });

    expect(transport.getInternalStateForTesting().discoveryRelayUrls).toEqual([
      ...DEFAULT_BOOTSTRAP_RELAY_URLS,
    ]);
  });

  test('explicit discovery relays override bootstrap discovery relays', () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      discoveryRelayUrls: ['wss://relay.example.com'],
    });

    expect(transport.getInternalStateForTesting().discoveryRelayUrls).toEqual([
      'wss://relay.example.com',
    ]);
  });

  test('stores configured fallback operational relays separately from discovery relays', () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      discoveryRelayUrls: ['wss://discovery.example.com'],
      fallbackOperationalRelayUrls: ['wss://fallback.example.com'],
    });

    expect(
      transport.getInternalStateForTesting().fallbackOperationalRelayUrls,
    ).toEqual(['wss://fallback.example.com']);
    expect(transport.getInternalStateForTesting().discoveryRelayUrls).toEqual([
      'wss://discovery.example.com',
    ]);
  });

  test('allows omitting relayHandler when using discovery-based resolution', () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
    });

    expect(transport.getInternalStateForTesting().relayUrls).toEqual([]);
    expect(transport.getInternalStateForTesting().discoveryRelayUrls).toEqual([
      ...DEFAULT_BOOTSTRAP_RELAY_URLS,
    ]);
  });

  test('resolves relay-list metadata from discovery relays when no operational relays are configured', async () => {
    const spawned = await spawnMockRelay();
    const discoveryRelayUrl = spawned.relayUrl;
    const serverSigner = new PrivateKeySigner('c'.repeat(64));
    const serverPubkey = await serverSigner.getPublicKey();

    try {
      const relayListPublisher = new ApplesauceRelayPool([discoveryRelayUrl]);
      await relayListPublisher.connect();

      const relayListEvent = await serverSigner.signEvent({
        kind: 10002,
        content: '',
        created_at: Math.floor(Date.now() / 1000),
        pubkey: serverPubkey,
        tags: [
          ['r', 'wss://relay-1.example.com'],
          ['r', 'wss://relay-2.example.com'],
        ],
      });
      await relayListPublisher.publish(relayListEvent);
      await relayListPublisher.disconnect();

      const transport = new NostrClientTransport({
        serverPubkey,
        signer: new PrivateKeySigner('a'.repeat(64)),
        relayHandler: [],
        discoveryRelayUrls: [discoveryRelayUrl],
      });

      await transport['resolveOperationalRelayHandler']();

      expect(transport.getInternalStateForTesting().relayUrls).toEqual([
        'wss://relay-1.example.com',
        'wss://relay-2.example.com',
      ]);
    } finally {
      spawned.stop();
      await sleep(100);
    }
  });

  test('uses fallback operational relays when discovery does not resolve a usable relay list', async () => {
    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: [],
      discoveryRelayUrls: [],
      fallbackOperationalRelayUrls: ['wss://fallback.example.com'],
    });

    await transport['resolveOperationalRelayHandler']();

    expect(transport.getInternalStateForTesting().relayUrls).toEqual([
      'wss://fallback.example.com',
    ]);
  });

  test('prefers discovery relays over fallback relays when discovery resolves first', async () => {
    const originalConnect = ApplesauceRelayPool.prototype.connect;

    ApplesauceRelayPool.prototype.connect = async function connectWithDelay(
      this: ApplesauceRelayPool,
    ): Promise<void> {
      const relayUrls = this.getRelayUrls?.() ?? [];

      if (relayUrls.includes('wss://fallback.example.com')) {
        await sleep(50);
      }

      return originalConnect.call(this);
    };

    const spawned = await spawnMockRelay();
    const discoveryRelayUrl = spawned.relayUrl;
    const serverSigner = new PrivateKeySigner('d'.repeat(64));
    const serverPubkey = await serverSigner.getPublicKey();

    try {
      const relayListPublisher = new ApplesauceRelayPool([discoveryRelayUrl]);
      await relayListPublisher.connect();

      const relayListEvent = await serverSigner.signEvent({
        kind: 10002,
        content: '',
        created_at: Math.floor(Date.now() / 1000),
        pubkey: serverPubkey,
        tags: [['r', 'wss://authoritative.example.com']],
      });
      await relayListPublisher.publish(relayListEvent);
      await relayListPublisher.disconnect();

      const transport = new NostrClientTransport({
        serverPubkey,
        signer: new PrivateKeySigner('a'.repeat(64)),
        relayHandler: [],
        discoveryRelayUrls: [discoveryRelayUrl],
        fallbackOperationalRelayUrls: ['wss://fallback.example.com'],
      });

      await transport['resolveOperationalRelayHandler']();

      expect(transport.getInternalStateForTesting().relayUrls).toEqual([
        'wss://authoritative.example.com',
      ]);
    } finally {
      ApplesauceRelayPool.prototype.connect = originalConnect;
      spawned.stop();
      await sleep(100);
    }
  });

  test('uses fallback relays when they become available before discovery resolves', async () => {
    const originalConnect = ApplesauceRelayPool.prototype.connect;

    ApplesauceRelayPool.prototype.connect = async function connectForFallback(
      this: ApplesauceRelayPool,
    ): Promise<void> {
      const relayUrls = this.getRelayUrls?.() ?? [];

      if (relayUrls.includes('wss://delayed-discovery.example.com')) {
        await sleep(50);
      }

      return originalConnect.call(this);
    };

    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: [],
      discoveryRelayUrls: ['wss://delayed-discovery.example.com'],
      fallbackOperationalRelayUrls: ['wss://fallback.example.com'],
    });

    try {
      await transport['resolveOperationalRelayHandler']();

      expect(transport.getInternalStateForTesting().relayUrls).toEqual([
        'wss://fallback.example.com',
      ]);
    } finally {
      ApplesauceRelayPool.prototype.connect = originalConnect;
    }
  });

  test('allows fallback relays to win before discovery completes because they connect first', async () => {
    const originalConnect = ApplesauceRelayPool.prototype.connect;

    ApplesauceRelayPool.prototype.connect = async function connectForRace(
      this: ApplesauceRelayPool,
    ): Promise<void> {
      const relayUrls = this.getRelayUrls?.() ?? [];

      if (relayUrls.includes('wss://slow-discovery.example.com')) {
        await sleep(50);
      }

      return originalConnect.call(this);
    };

    const transport = new NostrClientTransport({
      serverPubkey: 'b'.repeat(64),
      signer: new PrivateKeySigner('a'.repeat(64)),
      relayHandler: [],
      discoveryRelayUrls: ['wss://slow-discovery.example.com'],
      fallbackOperationalRelayUrls: ['wss://fallback.example.com'],
    });

    try {
      await transport['resolveOperationalRelayHandler']();

      expect(transport.getInternalStateForTesting().relayUrls).toEqual([
        'wss://fallback.example.com',
      ]);
    } finally {
      ApplesauceRelayPool.prototype.connect = originalConnect;
    }
  });
});
