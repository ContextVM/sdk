import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bytesToHex } from '@noble/hashes/utils';
import { sleep, type Subprocess } from 'bun';
import {
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
  type UnsignedEvent,
} from 'nostr-tools';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { ApplesauceRelayPool } from './applesauce-relay-pool.js';

describe('ApplesauceRelayPool Integration', () => {
  let relayProcess: Subprocess;
  const relayPort = 7780;
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

    // 2. Setup ApplesauceRelayPool
    const relayPool = new ApplesauceRelayPool([relayUrl]);
    await relayPool.connect();

    // 3. Create an event
    const unsignedEvent: UnsignedEvent = {
      kind: 1,
      pubkey: publicKeyHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'Hello from ApplesauceRelayPool test!',
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

  test('should handle EOSE (End of Stored Events) correctly', async () => {
    // 1. Setup ApplesauceRelayPool
    const relayPool = new ApplesauceRelayPool([relayUrl]);
    await relayPool.connect();

    // 2. Track EOSE calls
    let eoseReceived = false;
    const eosePromise = new Promise<void>((resolve) => {
      relayPool.subscribe(
        [{ kinds: [1], limit: 1 }],
        () => {
          // Event callback
        },
        () => {
          // EOSE callback
          eoseReceived = true;
          resolve();
        },
      );
    });

    // 3. Wait for EOSE
    await eosePromise;

    // 4. Assertions
    expect(eoseReceived).toBe(true);

    // 5. Cleanup
    relayPool.unsubscribe();
    await relayPool.disconnect();
  }, 5000);

  test('should unsubscribe correctly', async () => {
    // 1. Setup ApplesauceRelayPool
    const relayPool = new ApplesauceRelayPool([relayUrl]);
    await relayPool.connect();

    // 2. Setup signer
    const privateKey = generateSecretKey();
    const privateKeyHex = bytesToHex(privateKey);
    const publicKeyHex = getPublicKey(privateKey);
    const signer = new PrivateKeySigner(privateKeyHex);

    // 3. Create a unique tag for this test
    const uniqueTag = `unsubscribe-test-${Date.now()}`;

    // 4. Create a subscription with a specific filter for our unique tag
    const receivedEvents: NostrEvent[] = [];
    const subscriptionPromise = new Promise<void>((resolve) => {
      // Start a subscription
      relayPool.subscribe([{ kinds: [1], '#t': [uniqueTag] }], (event) => {
        receivedEvents.push(event);
        // Resolve after receiving one event
        if (receivedEvents.length === 1) {
          resolve();
        }
      });
    });

    // 5. Publish an event to trigger the subscription
    const unsignedEvent: UnsignedEvent = {
      kind: 1,
      pubkey: publicKeyHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', uniqueTag]],
      content: 'Test event for unsubscribe',
    };
    const signedEvent = await signer.signEvent(unsignedEvent);

    await relayPool.publish(signedEvent);

    // 6. Wait for the event to be received
    await subscriptionPromise;

    // 7. Unsubscribe
    relayPool.unsubscribe();

    // 8. Publish another event with the same unique tag
    const secondEvent: UnsignedEvent = {
      kind: 1,
      pubkey: publicKeyHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', uniqueTag]],
      content: 'Second test event after unsubscribe',
    };
    const secondSignedEvent = await signer.signEvent(secondEvent);
    await relayPool.publish(secondSignedEvent);

    // 9. Wait a bit to ensure no events are received
    await sleep(500);

    // 10. Assertions - should only have received the first event
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].id).toBe(signedEvent.id);

    // 11. Cleanup
    await relayPool.disconnect();
  }, 10000);

  test('should handle multiple relays', async () => {
    // 1. Setup a second relay process
    const secondRelayPort = 7781;
    const secondRelayUrl = `ws://localhost:${secondRelayPort}`;
    const secondRelayProcess = Bun.spawn(
      ['bun', 'src/__mocks__/mock-relay.ts'],
      {
        env: {
          ...process.env,
          PORT: `${secondRelayPort}`,
          DISABLE_MOCK_RESPONSES: 'true',
        },
      },
    );

    // Wait for the second relay to start
    await sleep(100);

    // 2. Setup ApplesauceRelayPool with both relays
    const relayPool = new ApplesauceRelayPool([relayUrl, secondRelayUrl]);
    await relayPool.connect();

    // 3. Setup signer
    const privateKey = generateSecretKey();
    const privateKeyHex = bytesToHex(privateKey);
    const publicKeyHex = getPublicKey(privateKey);
    const signer = new PrivateKeySigner(privateKeyHex);

    // 4. Create an event
    const unsignedEvent: UnsignedEvent = {
      kind: 1,
      pubkey: publicKeyHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'Hello from multiple relays test!',
    };
    const signedEvent = await signer.signEvent(unsignedEvent);

    // 5. Subscribe to receive the event
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

    // 6. Publish the event
    await relayPool.publish(signedEvent);

    // 7. Wait for the event to be received
    await receivedPromise;

    // 8. Assertions
    expect(receivedEvents.length).toBeGreaterThan(0);
    const receivedEvent = receivedEvents.find((e) => e.id === signedEvent.id);
    expect(receivedEvent).toBeDefined();
    expect(receivedEvent?.content).toBe(signedEvent.content);

    // 9. Cleanup
    relayPool.unsubscribe();
    await relayPool.disconnect();
    secondRelayProcess.kill();
  }, 15000);
});
