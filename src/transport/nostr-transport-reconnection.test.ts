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
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EncryptionMode } from '../core/interfaces.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_TIMEOUT_MS } from '../core/constants.js';

const baseRelayPort = 7792; // Use a different port to avoid conflicts
const secondaryRelayPort = 7793; // Second relay for multi-relay tests
const relayUrl = `ws://localhost:${baseRelayPort}`;
const secondaryRelayUrl = `ws://localhost:${secondaryRelayPort}`;

describe('NostrTransport Reconnection', () => {
  let relayProcess: Subprocess;
  let secondaryRelayProcess: Subprocess;
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

  beforeAll(async () => {
    // Start mock relay
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: { ...process.env, PORT: `${baseRelayPort}` },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    // Start secondary relay
    secondaryRelayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: { ...process.env, PORT: `${secondaryRelayPort}` },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await sleep(200);
  });

  afterEach(async () => {
    // Clear relay cache for both relays
    try {
      const clearUrl = relayUrl.replace('ws://', 'http://') + '/clear-cache';
      await fetch(clearUrl, { method: 'POST' });
      const secondaryClearUrl =
        secondaryRelayUrl.replace('ws://', 'http://') + '/clear-cache';
      await fetch(secondaryClearUrl, { method: 'POST' });
    } catch (error) {
      console.warn('[TEST] Failed to clear event cache:', error);
    }
  });

  afterAll(async () => {
    relayProcess?.kill();
    secondaryRelayProcess?.kill();
    await sleep(100);
  });

  /**
   * Helper function to create a server with basic tool
   */
  const createServer = async (
    relayUrls: string[] = [relayUrl],
  ): Promise<{ server: McpServer }> => {
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
      relayHandler: new ApplesauceRelayPool(relayUrls),
    });

    await server.connect(transport);
    return { server };
  };

  /**
   * Helper function to create a client
   */
  const createClient = async (
    relayUrls: string[] = [relayUrl],
  ): Promise<{ client: Client }> => {
    const client = new Client({
      name: 'Test-Client-Reconnection',
      version: '1.0.0',
    });
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool(relayUrls),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });

    await client.connect(transport);
    return { client };
  };

  test('should handle relay restart and continue processing requests', async () => {
    // Create server and client
    const { server: initialServer } = await createServer();
    const { client } = await createClient();

    // First request - should work
    const tools1 = await client.listTools();
    expect(tools1).toBeDefined();
    expect(Array.isArray(tools1.tools)).toBe(true);

    // Test tool call before relay restart
    const toolResult1 = (await client.callTool({
      name: 'add',
      arguments: { a: 5, b: 3 },
    })) as CallToolResult;
    expect(toolResult1).toBeDefined();
    expect(
      toolResult1.content[0].type === 'text' && toolResult1.content[0].text,
    ).toBe('8');

    // Restart the relay process
    console.log('Restarting relay...');
    relayProcess.kill();

    // Start relay again
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: { ...process.env, PORT: `${baseRelayPort}` },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    // Second request after relay restart - should still work
    const tools2 = await client.listTools();
    expect(tools2).toBeDefined();
    expect(Array.isArray(tools2.tools)).toBe(true);
    expect(tools2.tools.length).toBe(1);

    // Test tool call after relay restart
    const toolResult2 = (await client.callTool({
      name: 'add',
      arguments: { a: 10, b: 20 },
    })) as CallToolResult;
    expect(toolResult2).toBeDefined();
    expect(
      toolResult2.content[0].type === 'text' && toolResult2.content[0].text,
    ).toBe('30');

    await client.close();
    await initialServer.close();
  }, 20000);

  test(
    'should handle multiple relay restarts',
    async () => {
      const { server } = await createServer();
      const { client } = await createClient();

      // First request
      const tools1 = await client.listTools();
      expect(tools1).toBeDefined();

      // First relay restart
      console.log('First relay restart...');
      relayProcess.kill();
      relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
        env: { ...process.env, PORT: `${baseRelayPort}` },
        stdout: 'inherit',
        stderr: 'inherit',
      });

      // Request after first restart
      const toolResult1 = (await client.callTool({
        name: 'add',
        arguments: { a: 1, b: 2 },
      })) as CallToolResult;
      expect(
        toolResult1.content[0].type === 'text' && toolResult1.content[0].text,
      ).toBe('3');

      // Second relay restart
      console.log('Second relay restart...');
      relayProcess.kill();
      relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
        env: { ...process.env, PORT: `${baseRelayPort}` },
        stdout: 'inherit',
        stderr: 'inherit',
      });

      // Request after second restart
      const toolResult2 = (await client.callTool({
        name: 'add',
        arguments: { a: 7, b: 8 },
      })) as CallToolResult;
      expect(
        toolResult2.content[0].type === 'text' && toolResult2.content[0].text,
      ).toBe('15');

      await client.close();
      await server.close();
    },
    DEFAULT_TIMEOUT_MS,
  );

  test('should handle relay being offline for extended period (10 seconds)', async () => {
    const { server } = await createServer();
    const { client } = await createClient();

    // First request - should work
    const tools1 = await client.listTools();
    expect(tools1).toBeDefined();
    expect(Array.isArray(tools1.tools)).toBe(true);

    // Test tool call before relay goes offline
    const toolResult1 = (await client.callTool({
      name: 'add',
      arguments: { a: 5, b: 3 },
    })) as CallToolResult;
    expect(toolResult1).toBeDefined();
    expect(
      toolResult1.content[0].type === 'text' && toolResult1.content[0].text,
    ).toBe('8');

    // Kill the relay and wait for 10 seconds (simulating extended outage)
    console.log('Killing relay for extended outage (10 seconds)...');
    relayProcess.kill();

    // Wait for 10 seconds to simulate extended outage
    console.log('Waiting 10 seconds...');
    await sleep(10000);

    // Start relay again
    console.log('Restarting relay after extended outage...');
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: { ...process.env, PORT: `${baseRelayPort}` },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    // Wait a moment for relay to fully start
    await sleep(500);

    // Second request after extended outage - should still work
    const tools2 = await client.listTools();
    expect(tools2).toBeDefined();
    expect(Array.isArray(tools2.tools)).toBe(true);
    expect(tools2.tools.length).toBe(1);

    // Test tool call after extended outage
    const toolResult2 = (await client.callTool({
      name: 'add',
      arguments: { a: 15, b: 25 },
    })) as CallToolResult;
    expect(toolResult2).toBeDefined();
    expect(
      toolResult2.content[0].type === 'text' && toolResult2.content[0].text,
    ).toBe('40');

    await client.close();
    await server.close();
  }, 40000); // Longer timeout for extended outage test
  test('should handle one relay dropping in multi-relay setup', async () => {
    // Create server and client with both relays
    const { server } = await createServer([relayUrl, secondaryRelayUrl]);
    const { client } = await createClient([relayUrl, secondaryRelayUrl]);

    // First request - should work with both relays
    const tools1 = await client.listTools();
    expect(tools1).toBeDefined();
    expect(Array.isArray(tools1.tools)).toBe(true);

    // Test tool call before dropping one relay
    const toolResult1 = (await client.callTool({
      name: 'add',
      arguments: { a: 5, b: 3 },
    })) as CallToolResult;
    expect(toolResult1).toBeDefined();
    expect(
      toolResult1.content[0].type === 'text' && toolResult1.content[0].text,
    ).toBe('8');

    // Drop the primary relay
    console.log('Dropping primary relay...');
    relayProcess.kill();

    // Second request should still work through secondary relay
    const tools2 = await client.listTools();
    expect(tools2).toBeDefined();
    expect(Array.isArray(tools2.tools)).toBe(true);
    expect(tools2.tools.length).toBe(1);

    // Test tool call after dropping primary relay
    const toolResult2 = (await client.callTool({
      name: 'add',
      arguments: { a: 10, b: 20 },
    })) as CallToolResult;
    expect(toolResult2).toBeDefined();
    expect(
      toolResult2.content[0].type === 'text' && toolResult2.content[0].text,
    ).toBe('30');

    // Restart the primary relay
    console.log('Restarting primary relay...');
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: { ...process.env, PORT: `${baseRelayPort}` },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    // Wait for reconnection to complete
    await sleep(100);

    // Third request should work with both relays again
    const toolResult3 = (await client.callTool({
      name: 'add',
      arguments: { a: 15, b: 25 },
    })) as CallToolResult;
    expect(toolResult3).toBeDefined();
    expect(
      toolResult3.content[0].type === 'text' && toolResult3.content[0].text,
    ).toBe('40');

    await client.close();
    await server.close();
  }, 40000);
});
