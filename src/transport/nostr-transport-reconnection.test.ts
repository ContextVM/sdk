import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
} from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@contextvm/mcp-sdk/client';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { z } from 'zod';
import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';
import {
  type CallToolResult,
  isJSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';
import { DEFAULT_TIMEOUT_MS } from '../core/constants.js';
import { waitFor } from '../core/utils/test.utils.js';
import {
  spawnMockRelay,
  restartMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

describe.serial('NostrTransport Reconnection', () => {
  let stopPrimaryRelay: (() => void) | undefined;
  let stopSecondaryRelay: (() => void) | undefined;
  let primaryRelayInstance: Awaited<ReturnType<typeof spawnMockRelay>>['relay'];
  let relayUrl: string;
  let secondaryRelayUrl: string;
  let primaryHttpUrl: string;
  let secondaryHttpUrl: string;
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

  beforeAll(async () => {
    // Start primary relay on an OS-assigned port (avoids TOCTOU races under concurrency)
    const primaryRelay = await spawnMockRelay();
    primaryRelayInstance = primaryRelay.relay;
    stopPrimaryRelay = primaryRelay.stop;
    relayUrl = primaryRelay.relayUrl;
    primaryHttpUrl = primaryRelay.httpUrl;

    // Start secondary relay on an OS-assigned port
    const secondaryRelay = await spawnMockRelay();
    stopSecondaryRelay = secondaryRelay.stop;
    secondaryRelayUrl = secondaryRelay.relayUrl;
    secondaryHttpUrl = secondaryRelay.httpUrl;
  });

  afterEach(async () => {
    // Clear relay cache for both relays
    await clearRelayCache(primaryHttpUrl);
    await clearRelayCache(secondaryHttpUrl);
  });

  afterAll(async () => {
    stopPrimaryRelay?.();
    stopSecondaryRelay?.();
    await sleep(100);
  });

  /**
   * Helper function to restart the primary relay on the same port
   */
  const restartPrimaryRelay = async (): Promise<void> => {
    // Prefer pausing/resuming the in-process relay to avoid EADDRINUSE flakes.
    await restartMockRelay(primaryRelayInstance);
  };

  /**
   * Helper function to create a server with basic tool
   */
  const createServer = async (
    relayUrls: string[] = [relayUrl],
  ): Promise<McpServer> => {
    const server = new McpServer({
      name: 'Test-Server-Reconnection',
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

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool(relayUrls, {
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 1_000,
      }),
    });

    await server.connect(transport);
    return server;
  };

  /**
   * Helper function to create a client
   */
  const createClient = async (
    relayUrls: string[] = [relayUrl],
  ): Promise<Client> => {
    const client = new Client({
      name: 'Test-Client-Reconnection',
      version: '1.0.0',
    });
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool(relayUrls, {
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 1_000,
      }),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(transport);
    return client;
  };

  const eventually = async <T>(
    fn: () => Promise<T>,
    opts: {
      timeoutMs: number;
      intervalMs?: number;
      onError?: (error: unknown) => void;
    },
  ): Promise<T> => {
    const startMs = Date.now();
    const intervalMs = opts.intervalMs ?? 100;
    let lastError: unknown;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        opts.onError?.(error);

        if (Date.now() - startMs >= opts.timeoutMs) {
          throw lastError;
        }

        await sleep(intervalMs);
      }
    }
  };

  const assertToolsAvailable = async (
    client: Client,
    expectedCount?: number,
  ): Promise<void> => {
    const tools = await client.listTools();
    expect(tools).toBeDefined();
    expect(Array.isArray(tools.tools)).toBe(true);
    if (expectedCount !== undefined) {
      expect(tools.tools.length).toBe(expectedCount);
    }
  };

  const callAddTool = async (
    client: Client,
    a: number,
    b: number,
  ): Promise<CallToolResult> => {
    return (await client.callTool({
      name: 'add',
      arguments: { a, b },
    })) as CallToolResult;
  };

  const expectTextResult = (result: CallToolResult, expected: string): void => {
    expect(result).toBeDefined();
    expect(result.content[0].type === 'text' && result.content[0].text).toBe(
      expected,
    );
  };

  test.serial(
    'does not execute completed encrypted tool calls again after cache eviction and relay replay',
    async () => {
      const requestCount = 12;
      const executions = new Map<number, number>();
      const server = new McpServer({
        name: 'Replay-Safety-Server',
        version: '1.0.0',
      });
      server.registerTool(
        'count',
        { inputSchema: { sequence: z.number() } },
        async ({ sequence }) => {
          executions.set(sequence, (executions.get(sequence) ?? 0) + 1);
          return { content: [{ type: 'text', text: String(sequence) }] };
        },
      );

      const pool = new ApplesauceRelayPool([relayUrl], {
        reconnectBaseDelayMs: 100,
        reconnectMaxDelayMs: 1_000,
      });
      let receivedEvents = 0;
      let processedEvents = 0;
      let eoseCount = 0;
      let firstEnvelopeId: string | undefined;
      const subscribe = pool.subscribe.bind(pool);
      pool.subscribe = (filters, onEvent, onEose) =>
        subscribe(
          filters,
          (event) => {
            receivedEvents += 1;
            firstEnvelopeId ??= event.id;
            onEvent(event);
          },
          () => {
            eoseCount += 1;
            onEose?.();
          },
        );

      const serverTransport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: pool,
        encryptionMode: EncryptionMode.REQUIRED,
        giftWrapMode: GiftWrapMode.PERSISTENT,
        maxSessions: 1,
      });
      // Exercise real eviction with a small test-only cache, keeping CI fast.
      const envelopeCache = serverTransport['seenGiftWrapIds'];
      envelopeCache['capacity'] = 4;
      const processEvent =
        serverTransport['processIncomingEvent'].bind(serverTransport);
      serverTransport['processIncomingEvent'] = async (
        event,
      ): Promise<void> => {
        try {
          await processEvent(event);
        } finally {
          processedEvents += 1;
        }
      };

      const client = new Client({
        name: 'Replay-Safety-Client',
        version: '1.0.0',
      });
      const clientTransport = new NostrClientTransport({
        signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
        relayHandler: new ApplesauceRelayPool([relayUrl], {
          reconnectBaseDelayMs: 100,
          reconnectMaxDelayMs: 1_000,
        }),
        serverPubkey: serverPublicKey,
        isStateless: true,
        encryptionMode: EncryptionMode.REQUIRED,
        giftWrapMode: GiftWrapMode.PERSISTENT,
      });
      const pendingResponses = new Set<string | number>();
      const requestEventIds = new Set<string>();

      try {
        await server.connect(serverTransport);
        const onmessage = serverTransport.onmessage;
        serverTransport.onmessage = (message): void => {
          if (isJSONRPCRequest(message)) {
            pendingResponses.add(message.id);
            requestEventIds.add(String(message.id));
          }
          onmessage?.(message);
        };
        const send = serverTransport.send.bind(serverTransport);
        serverTransport.send = async (message): Promise<void> => {
          const requestId = 'id' in message ? message.id : undefined;
          try {
            await send(message);
          } finally {
            if (requestId !== undefined) {
              pendingResponses.delete(requestId);
            }
          }
        };
        await client.connect(clientTransport);

        for (let sequence = 0; sequence < requestCount; sequence += 1) {
          const result = (await client.callTool({
            name: 'count',
            arguments: { sequence },
          })) as CallToolResult;
          expectTextResult(result, String(sequence));
        }
        await waitFor({
          produce: () =>
            eoseCount > 0 &&
            processedEvents === receivedEvents &&
            pendingResponses.size === 0
              ? true
              : undefined,
        });
        expect([...executions.values()]).toEqual(Array(requestCount).fill(1));
        expect(firstEnvelopeId).toBeDefined();
        expect(envelopeCache.has(firstEnvelopeId!)).toBe(false);
        expect(
          serverTransport.getInternalStateForTesting().correlationStore
            .eventRouteCount,
        ).toBe(0);
        const { sessionStore } = serverTransport.getInternalStateForTesting();
        const [clientPubkey] = [...sessionStore.getAllSessions()][0];
        sessionStore.getOrCreateSession(
          getPublicKey(generateSecretKey()),
          false,
        );
        expect(sessionStore.hasSession(clientPubkey)).toBe(false);
        expect(requestEventIds.size).toBe(requestCount);
        for (const eventId of requestEventIds) {
          expect(serverTransport['seenEventIds'].has(eventId)).toBe(true);
        }
        const eventsBeforeRestart = receivedEvents;
        const eoseBeforeRestart = eoseCount;

        await restartPrimaryRelay();

        // EOSE can arrive while decryptions are queued or MCP responses are pending.
        await waitFor({
          produce: () =>
            eoseCount > eoseBeforeRestart &&
            receivedEvents >= eventsBeforeRestart + requestCount &&
            processedEvents === receivedEvents &&
            pendingResponses.size === 0
              ? true
              : undefined,
          timeoutMs: 15_000,
        });
        expect([...executions.values()]).toEqual(Array(requestCount).fill(1));

        const result = (await client.callTool({
          name: 'count',
          arguments: { sequence: requestCount },
        })) as CallToolResult;
        expectTextResult(result, String(requestCount));
        expect(executions.get(requestCount)).toBe(1);
        expect(executions.size).toBe(requestCount + 1);
      } finally {
        await client.close();
        await server.close();
        expect(envelopeCache.size).toBe(0);
        expect(serverTransport['seenEventIds'].size).toBe(0);
      }
    },
    30_000,
  );

  test.serial(
    'should handle relay restart and continue processing requests',
    async () => {
      // Create server and client
      const initialServer = await createServer();
      const client = await createClient();

      // First request - should work
      await assertToolsAvailable(client);

      // Test tool call before relay restart
      expectTextResult(await callAddTool(client, 5, 3), '8');

      // Restart the relay process
      await restartPrimaryRelay();

      // Second request after relay restart - should still work
      const toolResult2 = await eventually(() => callAddTool(client, 10, 20), {
        timeoutMs: 15_000,
        intervalMs: 150,
      });
      expectTextResult(toolResult2, '30');

      await client.close();
      await initialServer.close();
    },
    20000,
  );

  test.serial(
    'should handle multiple relay restarts',
    async () => {
      const server = await createServer();
      const client = await createClient();

      // First request
      await assertToolsAvailable(client);

      // First relay restart
      await restartPrimaryRelay();
      await sleep(300);

      // Request after first restart
      expectTextResult(await callAddTool(client, 1, 2), '3');

      // Second relay restart
      await restartPrimaryRelay();
      await sleep(300);

      // Request after second restart
      expectTextResult(await callAddTool(client, 7, 8), '15');

      await client.close();
      await server.close();
    },
    DEFAULT_TIMEOUT_MS,
  );

  test.serial(
    'should handle relay being offline for extended period (10 seconds)',
    async () => {
      const server = await createServer();
      const client = await createClient();

      // First request - should work
      await assertToolsAvailable(client);

      // Test tool call before relay goes offline
      expectTextResult(await callAddTool(client, 5, 3), '8');

      // Simulate the relay going offline and wait for 10 seconds (extended outage)
      primaryRelayInstance.pause();

      // Wait for 10 seconds to simulate extended outage
      await sleep(10000);

      // Bring relay back online (without releasing the port)
      await restartPrimaryRelay();

      // Second request after extended outage - should still work
      const toolResult2 = await eventually(() => callAddTool(client, 15, 25), {
        timeoutMs: 25_000,
        intervalMs: 200,
      });
      expectTextResult(toolResult2, '40');

      await client.close();
      await server.close();
    },
    40000,
  ); // Longer timeout for extended outage test
  test.serial(
    'should handle one relay dropping in multi-relay setup',
    async () => {
      // Create server and client with both relays
      const server = await createServer([relayUrl, secondaryRelayUrl]);
      const client = await createClient([relayUrl, secondaryRelayUrl]);

      // First request - should work with both relays
      await assertToolsAvailable(client);

      // Test tool call before dropping one relay
      expectTextResult(await callAddTool(client, 5, 3), '8');

      // Drop the primary relay (without releasing the port)
      primaryRelayInstance.pause();

      // Second request should still work through secondary relay
      await assertToolsAvailable(client, 1);

      // Test tool call after dropping primary relay
      expectTextResult(await callAddTool(client, 10, 20), '30');

      // Restart the primary relay
      await restartPrimaryRelay();

      // Wait for reconnection to complete
      await sleep(100);

      // Third request should work with both relays again
      expectTextResult(await callAddTool(client, 15, 25), '40');

      await client.close();
      await server.close();
    },
    40000,
  );
});
