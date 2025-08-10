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
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioClientTransport as StdioClientTransportForGateway } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TEST_PRIVATE_KEY } from '../__mocks__/fixtures.js';
import { NostrMCPGateway } from '../gateway/index.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';

const baseRelayPort = 7780;
const relayUrl = `ws://localhost:${baseRelayPort}`;

describe('Proxy-Gateway E2E Test (Without Mock Responses)', () => {
  let relayProcess: Subprocess;
  let gateway: NostrMCPGateway;

  // Generate keys for gateway and proxy
  const gatewayPrivateKey = TEST_PRIVATE_KEY;
  const gatewayPublicKey = getPublicKey(hexToBytes(gatewayPrivateKey));

  const proxyPrivateKey = bytesToHex(generateSecretKey());

  beforeAll(async () => {
    // Find an available port

    // Start the mock relay without predefined responses
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${baseRelayPort}`,
        DISABLE_MOCK_RESPONSES: 'true', // This is key - no predefined responses
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    // Wait for relay to start
    await sleep(100);

    // Create the gateway with the mock MCP server transport
    const mcpServerTransport = new StdioClientTransportForGateway({
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
  });

  afterEach(async () => {
    // Give some time for any client connections to close properly
    await sleep(100);

    // // Clear the mock relay's event cache to prevent cross-test contamination
    if (relayUrl) {
      try {
        const clearUrl = relayUrl.replace('ws://', 'http://') + '/clear-cache';
        await fetch(clearUrl, { method: 'POST' });
        console.log('[TEST] Event cache cleared');
      } catch (error) {
        console.warn('[TEST] Failed to clear event cache:', error);
      }
    }
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

  const getProxyTransport = () => {
    return new StdioClientTransport({
      command: 'bun',
      args: ['src/__mocks__/proxy-stdio-server.ts'],
      env: {
        ...process.env,
        RELAY_URL: relayUrl,
        CLIENT_PRIVATE_KEY: proxyPrivateKey,
        SERVER_PUBKEY: gatewayPublicKey,
      },
    });
  };

  test('should connect through proxy to gateway and initialize', async () => {
    const transport = getProxyTransport();

    const client = new Client({
      name: 'e2e-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);
    console.log('Client connected through proxy to gateway');

    // Verify gateway is active
    expect(gateway.isActive()).toBe(true);

    await client.close();
  }, 15000);

  test('should list tools through proxy-gateway chain', async () => {
    const transport = getProxyTransport();

    const client = new Client({
      name: 'tools-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);

    // List tools from the mock MCP server through the gateway
    const tools = await client.listTools();
    expect(tools).toBeDefined();
    expect(tools.tools).toBeDefined();
    expect(tools.tools.length).toBeGreaterThan(0);

    // Verify the mock server provides the 'add' tool
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain('add');

    // Verify the tool has the expected structure
    const addTool = tools.tools.find((tool) => tool.name === 'add');
    expect(addTool).toBeDefined();
    expect(addTool!.title).toBe('Addition Tool');
    expect(addTool!.description).toBe('Add two numbers');

    await client.close();
  }, 15000);

  test('should call tool through proxy-gateway chain', async () => {
    const transport = getProxyTransport();

    const client = new Client({
      name: 'tool-call-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);

    // Call the 'add' tool with specific arguments
    const result = await client.callTool({
      name: 'add',
      arguments: { a: 5, b: 3 },
    });

    expect(result).toBeDefined();
    const toolResult = result as CallToolResult;
    expect(toolResult.content).toBeDefined();
    expect(toolResult.content.length).toBe(1);
    expect(toolResult.content[0]).toEqual({
      type: 'text',
      text: '8', // 5 + 3 = 8
    });

    await client.close();
  }, 15000);

  test('should list resources through proxy-gateway chain', async () => {
    const transport = getProxyTransport();

    const client = new Client({
      name: 'resources-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);

    // List resources from the mock MCP server
    const resources = await client.listResourceTemplates();
    expect(resources).toBeDefined();
    expect(resources.resourceTemplates).toBeDefined();
    // The mock server uses a template resource with list: undefined, so no resources are listed
    expect(resources.resourceTemplates.length).toBe(1);

    await client.close();
  }, 15000);

  test('should read resource through proxy-gateway chain', async () => {
    const transport = getProxyTransport();

    const client = new Client({
      name: 'resource-read-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);

    // Read a specific greeting resource
    const result = await client.readResource({
      uri: 'greeting://World',
    });

    expect(result).toBeDefined();
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBe(1);
    expect(result.contents[0]).toMatchObject({
      uri: 'greeting://World',
      text: 'Hello, World!',
    });

    await client.close();
  }, 15000);

  test('should handle multiple concurrent requests through proxy-gateway chain', async () => {
    const transport = getProxyTransport();

    const client = new Client({
      name: 'concurrent-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);

    // Make multiple concurrent requests to test ID correlation
    const [toolsList, resourcesList, toolCall1, toolCall2] = await Promise.all([
      client.listTools(),
      client.listResourceTemplates(),
      client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }),
      client.callTool({ name: 'add', arguments: { a: 10, b: 20 } }),
    ]);

    // Verify all requests got appropriate responses
    expect(toolsList.tools.length).toBeGreaterThan(0);
    // The mock server has no listable resources (template with list: undefined)
    expect(resourcesList.resourceTemplates.length).toBe(1);

    const result1 = toolCall1 as CallToolResult;
    const result2 = toolCall2 as CallToolResult;

    expect(result1.content[0]).toEqual({
      type: 'text',
      text: '3', // 1 + 2 = 3
    });

    expect(result2.content[0]).toEqual({
      type: 'text',
      text: '30', // 10 + 20 = 30
    });

    await client.close();
  }, 15000);

  test('should handle error cases through proxy-gateway chain', async () => {
    const transport = getProxyTransport();

    const client = new Client({
      name: 'error-test-client',
      version: '1.0.0',
    });

    await client.connect(transport);

    // Try to call a non-existent tool
    try {
      await client.callTool({
        name: 'nonexistent-tool',
        arguments: {},
      });
      // If we get here, the test should fail
      expect(true).toBe(false);
    } catch (error) {
      // This should throw an error, which is expected
      expect(error).toBeDefined();
    }

    await client.close();
  }, 15000);
});
