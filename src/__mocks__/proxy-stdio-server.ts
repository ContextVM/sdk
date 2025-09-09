#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NostrMCPProxy } from '../proxy/index.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey } from 'nostr-tools';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { EncryptionMode } from '../core/interfaces.js';

/**
 * Proxy server that exposes a remote Nostr MCP server via stdio.
 * This allows MCP clients to connect to remote servers through the Nostr network.
 */
async function main(): Promise<void> {
  // Get configuration from environment variables
  const relayUrl = process.env.RELAY_URL || 'ws://localhost:10547';
  const clientPrivateKey =
    process.env.CLIENT_PRIVATE_KEY || bytesToHex(generateSecretKey());
  const serverPubkey = process.env.SERVER_PUBKEY;
  if (!clientPrivateKey) {
    console.error('CLIENT_PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  if (!serverPubkey) {
    console.error('SERVER_PUBKEY environment variable is required');
    process.exit(1);
  }

  // Set up stdio transport for the server
  const transport = new StdioServerTransport();

  // Create Nostr components
  const signer = new PrivateKeySigner(clientPrivateKey);
  const relayPool = new ApplesauceRelayPool([relayUrl]);

  // Create and start the proxy
  const proxy = new NostrMCPProxy({
    mcpHostTransport: transport,
    nostrTransportOptions: {
      signer,
      relayHandler: relayPool,
      serverPubkey,
      encryptionMode: EncryptionMode.DISABLED,
    },
  });

  // Handle cleanup on process termination
  process.on('SIGINT', async () => {
    await proxy.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await proxy.stop();
    process.exit(0);
  });

  // Start the proxy
  await proxy.start();
  console.error('Proxy server started and connected to stdio');
}

// Run the server
main().catch((error) => {
  console.error('Proxy server error:', error);
  process.exit(1);
});
