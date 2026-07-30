import { RelayGroup } from 'applesauce-relay';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { startMockRelay } from './src/__mocks__/mock-relay-server.ts';

async function run() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const relay = startMockRelay(pk, { port: 53998 });
  const group = new RelayGroup([relay.url]);
  group.req([{ kinds: [1] }]).subscribe(msg => {
    console.log("RECEIVED IN GROUP REQ:", JSON.stringify(msg));
    process.exit(0);
  });
  setTimeout(() => {
    relay.send(['EVENT', 'any', { id: 'abc', kind: 1, created_at: 0, content: 'test', tags: [], pubkey: pk, sig: '' }]);
  }, 100);
}
run();
