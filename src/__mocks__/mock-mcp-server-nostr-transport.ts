import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NostrServerTransport } from '../transport/nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { TEST_PRIVATE_KEY } from './fixtures.js';
import { SimpleRelayPool } from '../relay/simple-relay-pool.js';

// Create an MCP server
const server = new McpServer({
  name: 'demo-server',
  version: '1.0.0',
});

// Add an addition tool
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

// Add a dynamic greeting resource
server.registerResource(
  'greeting',
  new ResourceTemplate('greeting://{name}', { list: undefined }),
  {
    title: 'Greeting Resource', // Display name for UI
    description: 'Dynamic greeting generator',
  },
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        text: `Hello, ${name}!`,
      },
    ],
  }),
);

// Start receiving messages on stdin and sending messages on stdout
const transport = new NostrServerTransport({
  signer: new PrivateKeySigner(TEST_PRIVATE_KEY),
  relayHandler: new SimpleRelayPool(['ws://localhost:10547']),
  isPublicServer: false,
  serverInfo: {
    name: 'demo-server',
    website: 'https://model-context.org',
    picture:
      'https://www.contextvm.org/_astro/contextvm-logo.CHHzLZGt_A0IIg.svg',
  },
});

await server.connect(transport);
