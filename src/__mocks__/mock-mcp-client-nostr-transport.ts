import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey } from 'nostr-tools';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { sleep } from '../core/utils/utils.js';
import { TEST_PUBLIC_KEY } from './fixtures.js';

const client = new Client({
  name: `mock-client`,
  version: '1.0.0',
});

const transport = new NostrClientTransport({
  signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
  relayHandler: ['ws://localhost:10547'],
  serverPubkey: TEST_PUBLIC_KEY,
  isStateless: true,
});

await client.connect(transport);
await client.listTools();
await sleep(1000);
const callTool = await client.callTool({
  name: 'add',
  arguments: {
    a: 1,
    b: 2,
  },
});
console.log(callTool);
