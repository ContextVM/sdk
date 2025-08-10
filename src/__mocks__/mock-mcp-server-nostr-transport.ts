import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NostrServerTransport } from '../transport/nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { TEST_PRIVATE_KEY } from './fixtures.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';

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
  relayHandler: new ApplesauceRelayPool(['ws://localhost:10547']),
  isPublicServer: true,
  serverInfo: {
    name: 'demo-server',
    website: 'https://model-context.org',
    picture:
      'https://www.contextvm.org/_astro/contextvm-logo.CHHzLZGt_A0IIg.svg',
    about:
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Mauris sed ligula maximus, porta mauris non, finibus est. Etiam quis enim augue. In posuere sed lorem vitae posuere. Nullam mattis nisl sit amet purus blandit molestie vel eget lorem. Cras ligula ex, pharetra et ex vitae, tincidunt pretium ex. Morbi et eros quam. Aliquam non ex non orci tristique dictum sed quis nisi. Mauris lacus eros, lacinia eu ipsum at, rhoncus laoreet urna. Donec id interdum mauris. Donec ultrices, eros eget tristique tempus, metus odio vehicula diam, eu varius lectus elit viverra mi. Aliquam erat volutpat. Aenean efficitur ullamcorper efficitur. Quisque posuere enim elit, nec pulvinar nisi finibus nec. Morbi sollicitudin nibh arcu, at gravida tellus tincidunt et. Maecenas sagittis ex vel vulputate bibendum. Phasellus luctus metus ut enim commodo vestibulum. Sed malesuada blandit sollicitudin. Donec at lobortis tortor, et vulputate ipsum. Etiam vulputate luctus maximus. Donec tincidunt lectus nec tellus iaculis tincidunt',
  },
});

await server.connect(transport);
