import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { sleep, type Subprocess } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TEST_PRIVATE_KEY } from '../__mocks__/fixtures.js';
import { NostrMCPGateway } from './index.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';

describe('NostrMCPGateway End-to-End Test', () => {
  let relayProcess: Subprocess;
  let gateway: NostrMCPGateway;

  const relayPort = 7780;
  const relayUrl = `ws://localhost:${relayPort}`;

  // Generate a test private key for the gateway
  const gatewayPrivateKey = TEST_PRIVATE_KEY;
  const gatewayPublicKey = getPublicKey(hexToBytes(gatewayPrivateKey));

  beforeAll(async () => {
    // Start the mock relay
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${relayPort}`,
        DISABLE_MOCK_RESPONSES: 'true',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    // Wait for relay to start
    await sleep(100);

    // Create the gateway with the mock server transport
    const mcpServerTransport = new StdioClientTransport({
      command: 'bun',
      args: ['src/__mocks__/mock-mcp-server.ts'],
    });

    const gatewaySigner = new PrivateKeySigner(gatewayPrivateKey);
    const gatewayRelayHandler = new ApplesauceRelayPool([relayUrl]);

    gateway = new NostrMCPGateway({
      mcpServerTransport,
      nostrTransportOptions: {
        signer: gatewaySigner,
        relayHandler: gatewayRelayHandler,
      },
    });

    // Start the gateway
    console.log('Starting gateway...');
    await gateway.start();
    console.log('Gateway started, waiting for readiness...');

    // Wait for gateway to be ready
    await sleep(100);
  });

  afterAll(async () => {
    // Stop the gateway
    if (gateway) {
      await gateway.stop();
    }

    // Kill processes
    relayProcess?.kill();

    // Wait for cleanup
    await sleep(100);
  });

  const createClientTransport = (privateKey: string): NostrClientTransport => {
    const clientSigner = new PrivateKeySigner(privateKey);
    const clientRelayHandler = new ApplesauceRelayPool([relayUrl]);

    return new NostrClientTransport({
      signer: clientSigner,
      relayHandler: clientRelayHandler,
      serverPubkey: gatewayPublicKey,
    });
  };

  test('should handle concurrent client connections', async () => {
    const clients: Client[] = [];
    const transports: NostrClientTransport[] = [];
    const numberOfClients = 5;
    for (let i = 0; i < numberOfClients; i++) {
      const transport = createClientTransport(bytesToHex(generateSecretKey()));
      const client = new Client({
        name: `concurrent-client-${i}`,
        version: '1.0.0',
      });

      transports.push(transport);
      clients.push(client);
    }

    // Connect all clients concurrently
    await Promise.all(
      clients.map((client, index) => client.connect(transports[index])),
    );

    // Verify all clients are connected by checking gateway state
    expect(gateway.isActive()).toBe(true);

    const toolLists = await Promise.all(
      clients.map((client) => client.listTools()),
    );

    expect(toolLists).toBeDefined();
    expect(toolLists.length).toBe(numberOfClients);
    // Close all clients
    await Promise.all(clients.map((client) => client.close()));
  }, 5000);

  test('should handle concurrent tool calls and properly correlate requests and responses', async () => {
    const clients: Client[] = [];
    const transports: NostrClientTransport[] = [];
    const numberOfClients = 5;

    // Create multiple clients
    for (let i = 0; i < numberOfClients; i++) {
      const transport = createClientTransport(bytesToHex(generateSecretKey()));
      const client = new Client({
        name: `tool-client-${i}`,
        version: '1.0.0',
      });

      transports.push(transport);
      clients.push(client);
    }

    // Connect all clients
    await Promise.all(
      clients.map((client, index) => client.connect(transports[index])),
    );

    // Each client calls the same tool with different arguments
    const toolCallPromises = clients.map((client, index) => {
      return client.callTool({
        name: 'add',
        arguments: {
          a: index + 1,
          b: (index + 1) * 10,
        },
      });
    });

    // Wait for all tool calls to complete
    const results = await Promise.all(toolCallPromises);

    // Verify that each client received the correct response for their specific request
    results.forEach((result, index) => {
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();

      // The mock server returns the sum in the content
      const expectedSum = index + 1 + (index + 1) * 10;
      expect(result.content).toEqual([
        {
          type: 'text',
          text: `${expectedSum}`,
        },
      ]);
    });

    // Verify we got the expected number of results
    expect(results.length).toBe(numberOfClients);

    // Close all clients
    await Promise.all(clients.map((client) => client.close()));
  }, 10000);
});
