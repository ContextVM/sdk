import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
} from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EncryptionMode } from '../core/interfaces.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_TIMEOUT_MS } from '../core/constants.js';
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
