import { Relay } from 'applesauce-relay';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { startMockRelay } from './src/__mocks__/mock-relay-server.ts';
import { firstValueFrom } from 'rxjs';

async function run() {
  const pk = getPublicKey(generateSecretKey());
  const relayServer = startMockRelay(pk, { port: 53997 });
  const relay = new Relay(relayServer.url);
  await relay.connect();
  
  relay.message$.subscribe(msg => {
    console.log("MSG IS ARRAY?", Array.isArray(msg));
    console.log("MSG TYPE:", typeof msg);
    console.log("MSG PAYLOAD:", msg);
    process.exit(0);
  });
  
  relayServer.send(['EOSE', 'test-ping']);
}
run();
