import { startMockRelay } from "./src/__mocks__/mock-relay-server.ts";
import { ApplesauceRelayPool } from "./src/relay/applesauce-relay-pool.ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";

async function run() {
  const pk = getPublicKey(generateSecretKey());
  const relay = startMockRelay(pk, { port: 53999 });
  const pool = new ApplesauceRelayPool([relay.url]);
  await pool.connect();
  let received = false;
  pool.createSubscription([{ kinds: [1] }], (ev) => {
    console.log("EVENT RECEIVED", ev);
    received = true;
  });
  
  setTimeout(() => {
    relay.send(['EVENT', 'any', { id: 'abc', kind: 1, created_at: 0, content: 'test', tags: [], pubkey: pk, sig: '' }]);
  }, 100);

  setTimeout(() => {
    console.log("RECEIVED?", received);
    process.exit(0);
  }, 500);
}

run();
