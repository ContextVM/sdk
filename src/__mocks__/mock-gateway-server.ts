#!/usr/bin/env bun
import { NostrMCPGateway } from '../gateway/index.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey } from 'nostr-tools';

/**
 * Mock gateway server that exposes a local MCP server via Nostr transport.
 * This allows Nostr clients to connect to local MCP servers through the Nostr network.
 */
async function main(): Promise<void> {
  // Get configuration from environment variables
  const relayUrl = process.env.RELAY_URL || 'ws://localhost:10547';
  const gatewayPrivateKey =
    process.env.GATEWAY_PRIVATE_KEY || bytesToHex(generateSecretKey());

  // Set up stdio transport for the MCP server
  const mcpServerTransport = new StdioClientTransport({
    command: 'uvx',
    args: ['duckduckgo-mcp-server'],
  });

  // Create Nostr components
  const signer = new PrivateKeySigner(gatewayPrivateKey);
  const relayHandler = new ApplesauceRelayPool([relayUrl]);

  // Create and start the gateway
  const gateway = new NostrMCPGateway({
    mcpServerTransport,
    nostrTransportOptions: {
      signer,
      relayHandler,
      isPublicServer: true,
      serverInfo: {
        name: 'Mock Gateway Server',
        website: 'https://github.com/example/ctxvm',
        about: 'A mock gateway server for testing Nostr MCP integration',
      },
    },
  });

  // Handle cleanup on process termination
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    await gateway.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await gateway.stop();
    process.exit(0);
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });

  // Start the gateway
  await gateway.start();
  console.error('Mock gateway server started and connected to stdio');
  console.error('Gateway public key:', await signer.getPublicKey());
  console.error('Relay URL:', relayUrl);
}

// Run the server
main().catch((error) => {
  console.error('Mock gateway server error:', error);
  process.exit(1);
});
