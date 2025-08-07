import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { sleep, type Subprocess } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TEST_PRIVATE_KEY } from '../__mocks__/fixtures.js';
import { NostrMCPGateway } from './index.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { SimpleRelayPool } from '../relay/simple-relay-pool.js';
import { getPublicKey } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { createLogger } from '../core/utils/logger.js';

describe('NostrMCPGateway End-to-End Test', () => {
  let relayProcess: Subprocess;
  let gateway: NostrMCPGateway;
  const logger = createLogger('gateway-test');

  const relayPort = 7780;
  const relayUrl = `ws://localhost:${relayPort}`;

  // Generate a test private key for the gateway
  const gatewayPrivateKey = TEST_PRIVATE_KEY;
  const gatewayPublicKey = getPublicKey(hexToBytes(gatewayPrivateKey));

  // Generate a different private key for the client
  const clientPrivateKey = 'a'.repeat(64);

  beforeAll(async () => {
    // Start the mock relay
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${relayPort}`,
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
      stderr: 'pipe', // Explicitly set stderr to pipe so we can capture it
    });

    // Capture stderr from the MCP server and log it through the gateway logger
    if (mcpServerTransport.stderr) {
      mcpServerTransport.stderr.on('data', (data: string) => {
        const message = data.toString();
        logger.info(`MCP Server stderr: ${message.trim()}`);
      });
    }

    const gatewaySigner = new PrivateKeySigner(gatewayPrivateKey);
    const gatewayRelayHandler = new SimpleRelayPool([relayUrl]);

    gateway = new NostrMCPGateway({
      mcpServerTransport,
      nostrTransportOptions: {
        signer: gatewaySigner,
        relayHandler: gatewayRelayHandler,
        isPublicServer: true,
        serverInfo: {
          name: 'Test Server',
          website: 'http://localhost',
        },
      },
    });

    // Start the gateway
    console.log('Starting gateway...');
    await gateway.start();
    console.log('Gateway started, waiting for readiness...');

    // Wait for gateway to be ready
    await sleep(100);
    console.log('Gateway should be ready now');
    console.log('Gateway public key:', gatewayPublicKey);
    console.log(
      'Client public key:',
      getPublicKey(hexToBytes(clientPrivateKey)),
    );
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

  const createClientTransport = (): NostrClientTransport => {
    const clientSigner = new PrivateKeySigner(clientPrivateKey);
    const clientRelayHandler = new SimpleRelayPool([relayUrl]);

    return new NostrClientTransport({
      signer: clientSigner,
      relayHandler: clientRelayHandler,
      serverPubkey: gatewayPublicKey,
    });
  };

  test('should connect to gateway and initialize', async () => {
    const transport = createClientTransport();

    const client = new Client({
      name: 'e2e-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);
    console.log('Client connected to gateway');

    // Verify gateway is active
    expect(gateway.isActive()).toBe(true);

    await client.close();
  }, 10000);

  test('should list tools through gateway', async () => {
    const transport = createClientTransport();
    const client = new Client({
      name: 'tools-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);

    // List tools from the mock MCP server
    const tools = await client.listTools();
    expect(tools).toBeDefined();
    expect(tools.tools).toBeDefined();

    // Verify the mock server provides expected tools
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain('add');

    await client.close();
  }, 10000);
  test('should capture stderr output from underlying MCP server transport', async () => {
    // Create a custom transport that captures stderr to demonstrate the issue
    const stderrBuffer: string[] = [];

    // Create a custom transport that spawns the process and captures stderr
    const customTransport = new StdioClientTransport({
      command: 'bun',
      args: ['src/__mocks__/mock-mcp-server.ts'],
      stderr: 'pipe', // Explicitly set stderr to pipe so we can capture it
    });

    // Monkey patch the transport to capture stderr
    const originalStart = customTransport.start;
    customTransport.start = async () => {
      // Start the transport normally
      await originalStart.call(customTransport);

      // Access the stderr stream from the transport
      // The MCP SDK should expose this when stderr: 'pipe' is set
      if (customTransport.stderr) {
        customTransport.stderr.on('data', (data: string) => {
          const message = data.toString();
          stderrBuffer.push(message);
          console.log('Captured stderr from MCP server:', message.trim());
        });

        // Also listen for end event
        customTransport.stderr.on('end', () => {
          console.log('stderr stream ended');
        });

        // Listen for error event
        customTransport.stderr.on('error', (error) => {
          console.log('stderr error:', error);
        });
      } else {
        console.log('No stderr stream available from transport');
      }
    };

    // Replace the gateway's transport with our custom one
    const gatewaySigner = new PrivateKeySigner(gatewayPrivateKey);
    const gatewayRelayHandler = new SimpleRelayPool([relayUrl]);

    const testGateway = new NostrMCPGateway({
      mcpServerTransport: customTransport,
      nostrTransportOptions: {
        signer: gatewaySigner,
        relayHandler: gatewayRelayHandler,
        isPublicServer: true,
        serverInfo: {
          name: 'Test Server',
          website: 'http://localhost',
        },
      },
    });

    // Start the test gateway
    await testGateway.start();

    // Wait for the interval in the mock server to produce stderr output
    // The mock server calls server.sendToolListChanged() every 5 seconds
    await sleep(6000);

    // Stop the test gateway
    await testGateway.stop();

    // The stderr should contain output from the interval-based notifications
    // Currently, this test will show that stderr is not being captured
    console.log('Total stderr captured:', stderrBuffer.length, 'lines');
    console.log('Sample stderr output:', stderrBuffer.slice(0, 3).join(''));

    // This test demonstrates the issue: stderr is not being captured
    // In a proper implementation, we would expect to see stderr output here
    expect(stderrBuffer.length).toBeGreaterThan(0);

    // Clean up
    if (testGateway.isActive()) {
      await testGateway.stop();
    }
  }, 15000);
});
