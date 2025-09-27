import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey } from 'nostr-tools';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { SimpleRelayPool } from '../relay/simple-relay-pool.js';
import { sleep } from '../core/utils/utils.js';
import { EncryptionMode } from '../core/interfaces.js';

const client = new Client({
  name: `mock-client`,
  version: '1.0.0',
});

const transport = new NostrClientTransport({
  signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
  relayHandler: new SimpleRelayPool(['ws://localhost:10547']),
  serverPubkey:
    'ada13b4dbc773890a5e8e468b72418b9fffb51c40b78236819a721971b14fed1',
  encryptionMode: EncryptionMode.DISABLED,
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
