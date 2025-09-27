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
import { generateSecretKey, getPublicKey, NostrEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { EncryptionMode } from '../core/interfaces.js';

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
});
