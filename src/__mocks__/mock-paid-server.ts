import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { z } from 'zod';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { nip19 } from 'nostr-tools';
import { NostrServerTransport } from '../transport/nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { FakePaymentProcessor, withServerPayments } from '../payments/index.js';

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:10547';

const sk = generateSecretKey();
const privateKey = bytesToHex(sk);
const publicKey = getPublicKey(sk);
const npub = nip19.npubEncode(publicKey);

const mcpServer = new McpServer({
  name: 'mock-paid-server',
  version: '1.0.0',
});

mcpServer.registerTool(
  'echo',
  {
    title: 'Echo Tool',
    description: 'Echoes back the provided message',
    inputSchema: { message: z.string() },
  },
  async ({ message }: { message: string }) => ({
    content: [{ type: 'text', text: message }],
  }),
);

const processor = new FakePaymentProcessor({
  pmi: 'fake',
  verifyDelayMs: 1000,
});

const serverTransport = withServerPayments(
  new NostrServerTransport({
    signer: new PrivateKeySigner(privateKey),
    relayHandler: [RELAY_URL],
    serverInfo: { name: 'mock-paid-server' },
  }),
  {
    processors: [processor],
    pricedCapabilities: [
      {
        method: 'tools/call',
        name: 'echo',
        amount: 1,
        currencyUnit: 'test',
        description: '1 test unit to call echo',
      },
    ],
  },
);

await mcpServer.connect(serverTransport);

console.log('Mock paid server running');
console.log(`  relay:  ${RELAY_URL}`);
console.log(`  pubkey: ${publicKey}`);
console.log(`  npub:   ${npub}`);
console.log(`  tool:   echo (costs 1 test unit, pmi: ${processor.pmi})`);
