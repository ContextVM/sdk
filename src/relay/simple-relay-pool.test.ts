import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bytesToHex } from 'nostr-tools/utils';
import { sleep, type Subprocess } from 'bun';
import {
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
  type UnsignedEvent,
} from 'nostr-tools';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { SimpleRelayPool } from './simple-relay-pool.js';

describe('RelayPool Integration', () => {
  let relayProcess: Subprocess;
  const relayPort = 7777;
  const relayUrl = `ws://localhost:${relayPort}`;

  beforeAll(async () => {
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${relayPort}`,
        DISABLE_MOCK_RESPONSES: 'true',
      },
    });
    // Wait for the relay to start
    await sleep(100);
  });

  afterAll(() => {
    relayProcess.kill();
  });

  test('should connect, publish, and subscribe to a mock relay', async () => {
    // 1. Setup signer
    const privateKey = generateSecretKey();
    const privateKeyHex = bytesToHex(privateKey);
    const publicKeyHex = getPublicKey(privateKey);
    const signer = new PrivateKeySigner(privateKeyHex);

    // 2. Setup RelayPool
    const relayPool = new SimpleRelayPool([relayUrl]);
    await relayPool.connect();

    // 3. Create an event
    const unsignedEvent: UnsignedEvent = {
      kind: 1,
      pubkey: publicKeyHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'Hello from RelayPool test!',
    };
    const signedEvent = await signer.signEvent(unsignedEvent);

    // 4. Subscribe to receive the event
    const receivedEvents: NostrEvent[] = [];
    const receivedPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Subscription timed out')),
        5000,
      );

      relayPool.subscribe(
        [{ authors: [publicKeyHex], kinds: [1] }],
        (event) => {
          receivedEvents.push(event);
          if (event.id === signedEvent.id) {
            clearTimeout(timeout);
            resolve();
          }
        },
      );
    });

    // 5. Publish the event
    await relayPool.publish(signedEvent);

    // 6. Wait for the event to be received
    await receivedPromise;

    // 7. Assertions
    expect(receivedEvents.length).toBeGreaterThan(0);
    const receivedEvent = receivedEvents.find((e) => e.id === signedEvent.id);
    expect(receivedEvent).toBeDefined();
    expect(receivedEvent?.content).toBe(signedEvent.content);

    // 8. Cleanup
    relayPool.unsubscribe();
    await relayPool.disconnect();
  }, 10000);

  test('should reconnect to relay after disconnection', async () => {
    // 1. Setup RelayPool
    const relayPool = new SimpleRelayPool([relayUrl]);
    await relayPool.connect();

    // 2. Verify initial connection
    const normalizedUrl = new URL(relayUrl).href;
    const initialStatus = relayPool['pool']
      .listConnectionStatus()
      .get(normalizedUrl);
    expect(initialStatus).toBe(true);

    // 3. Kill the relay process
    relayProcess.kill();

    // 4. Check that connection is lost
    const disconnectedStatus = relayPool['pool']
      .listConnectionStatus()
      .get(relayUrl);
    // Connection status might be undefined when not connected
    expect(disconnectedStatus).not.toBe(true);

    // 5. Restart the relay process
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${relayPort}`,
      },
    });

    // 6. Wait for relay to restart and reconnection to occur
    // The exponential backoff starts at 1s, so wait a bit longer
    await sleep(5100);

    // 7. Verify reconnection
    const reconnectedNormalizedUrl = new URL(relayUrl).href;
    const reconnectedStatus = relayPool['pool']
      .listConnectionStatus()
      .get(reconnectedNormalizedUrl);
    expect(reconnectedStatus).toBe(true);

    // 8. Cleanup
    relayPool.unsubscribe();
    await relayPool.disconnect();
  }, 15000);
});
