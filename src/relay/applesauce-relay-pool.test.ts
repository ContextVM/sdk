import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { bytesToHex } from 'nostr-tools/utils';
import { sleep } from 'bun';
import {
  generateSecretKey,
  getPublicKey,
  type Filter,
  type NostrEvent,
  type UnsignedEvent,
} from 'nostr-tools';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { ApplesauceRelayPool, PING_FILTER } from './applesauce-relay-pool.js';
import { Relay, RelayGroup } from 'applesauce-relay';
import { DEFAULT_TIMEOUT_MS } from '../core/constants.js';
import {
  spawnMockRelayOnPort,
  spawnMockRelayWithEnv,
} from '../__mocks__/test-relay-helpers.js';

/** Type for accessing private members in tests */
type TestableApplesauceRelayPool = Omit<ApplesauceRelayPool, 'relayGroup'> & {
  createRelay: (url: string) => Relay;
  rebuild: (reason: string) => void;
  subscriptions: Map<
    string,
    {
      id: string;
      filters: Filter[];
      onEvent: (event: NostrEvent) => void;
      onEose?: () => void;
      unsubscribe?: () => void;
    }
  >;
  rebuildInFlight?: Promise<void>;
};

/** Test timing constants */
const TIMING = {
  RELAY_STARTUP: 100,
  SHORT_WAIT: 500,
  SUBSCRIPTION_TIMEOUT: 5000,
  REBUILD_WAIT: 3000,
} as const;

/** Creates a test signer with generated key pair */
function createTestSigner(): {
  publicKeyHex: string;
  signer: PrivateKeySigner;
} {
  const privateKey = generateSecretKey();
  const privateKeyHex = bytesToHex(privateKey);
  const publicKeyHex = getPublicKey(privateKey);
  const signer = new PrivateKeySigner(privateKeyHex);
  return { publicKeyHex, signer };
}

/** Tracks rebuild method calls with proper typing */
function trackRebuildCalls(pool: ApplesauceRelayPool): {
  calls: Array<{ count: number; reason: string }>;
  restore: () => void;
} {
  const testPool = pool as unknown as TestableApplesauceRelayPool;
  const calls: Array<{ count: number; reason: string }> = [];
  const original = testPool.rebuild.bind(testPool);

  testPool.rebuild = function (reason: string) {
    calls.push({ count: calls.length + 1, reason });
    return original(reason);
  };

  return {
    calls,
    restore: () => {
      testPool.rebuild = original;
    },
  };
}

/** Tracks createRelay method calls */
function trackCreateRelayCalls(pool: ApplesauceRelayPool): {
  callCount: number;
  restore: () => void;
} {
  const testPool = pool as unknown as TestableApplesauceRelayPool;
  let callCount = 0;
  const original = testPool.createRelay.bind(testPool);

  testPool.createRelay = function (url: string) {
    callCount++;
    return original(url);
  };

  return {
    get callCount() {
      return callCount;
    },
    restore: () => {
      testPool.createRelay = original;
    },
  };
}

/** Gets typed access to internal state for assertions */
function getInternalState(pool: ApplesauceRelayPool): {
  subscriptions: TestableApplesauceRelayPool['subscriptions'];
} {
  const testPool = pool as unknown as TestableApplesauceRelayPool;
  return {
    get subscriptions() {
      return testPool.subscriptions;
    },
  };
}

describe('ApplesauceRelayPool Integration', () => {
  let stopRelay: (() => void) | undefined;
  let relayPort: number;
  let relayUrl: string;

  beforeAll(async () => {
    const relay = await spawnMockRelayWithEnv({
      DISABLE_MOCK_RESPONSES: 'true',
    });
    stopRelay = relay.stop;
    relayPort = relay.port;
    relayUrl = relay.relayUrl;
  });

  afterAll(() => {
    stopRelay?.();
  });

  test.serial(
    'should connect, publish, and subscribe to a mock relay',
    async () => {
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
    },
    10000,
  );

  test.serial(
    'should handle EOSE (End of Stored Events) correctly',
    async () => {
      // 1. Setup ApplesauceRelayPool
      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      // 2. Track EOSE calls
      let eoseReceived = false;
      const eosePromise = new Promise<void>((resolve) => {
        relayPool.subscribe(
          [{ kinds: [1], limit: 1 }],
          () => {},
          () => {
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
    },
    5000,
  );

  test.serial(
    'should unsubscribe correctly',
    async () => {
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
        relayPool.subscribe([{ kinds: [1], '#t': [uniqueTag] }], (event) => {
          receivedEvents.push(event);
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
    },
    10000,
  );

  test.serial(
    'should handle multiple relays',
    async () => {
      // 1. Setup a second relay process
      const secondRelay = await spawnMockRelayWithEnv({
        DISABLE_MOCK_RESPONSES: 'true',
      });
      const secondRelayUrl = secondRelay.relayUrl;
      const stopSecondRelay = secondRelay.stop;

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
      stopSecondRelay();
    },
    15000,
  );

  test.serial(
    'should handle offline relays in the pool',
    async () => {
      // 1. Setup ApplesauceRelayPool with one working relay and one offline relay
      const offlineRelayUrl = 'ws://localhost:1212'; // Non-existent relay
      const relayPool = new ApplesauceRelayPool([relayUrl, offlineRelayUrl]);

      // 2. Connect should succeed even with one offline relay
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
        content: 'Hello from mixed relay pool test!',
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

      // 8. Assertions - should still work with one offline relay
      expect(receivedEvents.length).toBeGreaterThan(0);
      const receivedEvent = receivedEvents.find((e) => e.id === signedEvent.id);
      expect(receivedEvent).toBeDefined();
      expect(receivedEvent?.content).toBe(signedEvent.content);

      // 9. Cleanup
      relayPool.unsubscribe();
      await relayPool.disconnect();
    },
    10000,
  );

  test.serial(
    'should eventually publish after a relay outage and recovery',
    async () => {
      // 1. Setup signer
      const privateKey = generateSecretKey();
      const privateKeyHex = bytesToHex(privateKey);
      const publicKeyHex = getPublicKey(privateKey);
      const signer = new PrivateKeySigner(privateKeyHex);

      // 2. Setup ApplesauceRelayPool
      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      // 3. Stop the relay to simulate an outage
      stopRelay?.();
      await sleep(3000);

      // 4. Create an event and start publishing while the relay is down
      const unsignedEvent: UnsignedEvent = {
        kind: 1059,
        pubkey: publicKeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'Publish during outage; should succeed after recovery',
      };
      const signedEvent = await signer.signEvent(unsignedEvent);

      const publishPromise = relayPool.publish(signedEvent);

      // 5. Restart the relay after a short downtime
      await sleep(1500);
      const restarted = await spawnMockRelayOnPort(relayPort);
      stopRelay = restarted.stop;

      // 6. Ensure publish eventually resolves
      await publishPromise;

      // 7. Cleanup
      relayPool.unsubscribe();
      await relayPool.disconnect();
    },
    DEFAULT_TIMEOUT_MS,
  );

  test.serial(
    'should rebuild on liveness timeout (unresponsive relay)',
    async () => {
      // 1. Start a relay that will be unresponsive for pings
      const unresponsiveRelay = await spawnMockRelayWithEnv({
        UNRESPONSIVE: 'true',
      });
      const unresponsiveRelayUrl = unresponsiveRelay.relayUrl;
      const stopUnresponsiveRelay = unresponsiveRelay.stop;

      // 2. Setup ApplesauceRelayPool with unresponsive relay, using fast ping for testing
      const relayPool = new ApplesauceRelayPool([unresponsiveRelayUrl], {
        pingFrequencyMs: 2000,
        pingTimeoutMs: 3000,
      });
      await relayPool.connect();

      // 3. Setup a subscription to trigger ping monitor
      relayPool.subscribe([{ kinds: [1] }], () => {});

      // Wait for rebuild to be triggered (ping timeout is 3s, we wait 10s)
      await sleep(10000);

      // 4. Cleanup
      relayPool.unsubscribe();
      await relayPool.disconnect();
      stopUnresponsiveRelay();
    },
    40000,
  );

  test.serial(
    'should handle rebuild triggers without crashing (graceful degradation)',
    async () => {
      // 1. Start a relay that will be unresponsive for pings
      const unresponsiveRelay = await spawnMockRelayWithEnv({
        UNRESPONSIVE: 'true',
      });
      const unresponsiveRelayUrl = unresponsiveRelay.relayUrl;
      const stopUnresponsiveRelay = unresponsiveRelay.stop;

      // 2. Setup ApplesauceRelayPool with unresponsive relay, using fast ping for testing
      const relayPool = new ApplesauceRelayPool([unresponsiveRelayUrl], {
        pingFrequencyMs: 1000,
        pingTimeoutMs: 2000,
      });
      await relayPool.connect();

      // 3. Track rebuild count by spying on createRelay using helper
      const createRelayTracker = trackCreateRelayCalls(relayPool);

      // 4. Setup subscription to trigger ping monitor
      relayPool.subscribe([{ kinds: [1] }], () => {});

      // 5. Wait for multiple liveness checks to trigger
      await sleep(6000);

      // 6. Assert multiple rebuilds happened
      expect(createRelayTracker.callCount).toBeGreaterThan(1);

      // 7. Cleanup
      createRelayTracker.restore();
      relayPool.unsubscribe();
      await relayPool.disconnect();
      stopUnresponsiveRelay();
    },
    DEFAULT_TIMEOUT_MS,
  );

  test.serial(
    'should cleanup subscription descriptors on unsubscribe',
    async () => {
      // 1. Setup ApplesauceRelayPool
      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      // 2. Get internal state using typed helper
      const internalState = getInternalState(relayPool);

      // 3. Add multiple subscriptions
      relayPool.subscribe([{ kinds: [1] }], () => {});
      relayPool.subscribe([{ kinds: [2] }], () => {});
      relayPool.subscribe([{ kinds: [3] }], () => {});

      // 4. Verify descriptors and unsubscribers are populated
      expect(internalState.subscriptions.size).toBe(3);

      // 5. Unsubscribe
      relayPool.unsubscribe();

      // 6. Verify both are cleaned up
      expect(internalState.subscriptions.size).toBe(0);

      // 7. Cleanup
      await relayPool.disconnect();
    },
    5000,
  );

  test.serial(
    'should handle disconnect during rebuild gracefully',
    async () => {
      // 1. Start a relay that will be unresponsive for pings
      const unresponsiveRelay = await spawnMockRelayWithEnv({
        UNRESPONSIVE: 'true',
      });
      const unresponsiveRelayUrl = unresponsiveRelay.relayUrl;
      const stopUnresponsiveRelay = unresponsiveRelay.stop;

      // 2. Setup ApplesauceRelayPool with fast ping for testing
      const relayPool = new ApplesauceRelayPool([unresponsiveRelayUrl], {
        pingFrequencyMs: 500,
        pingTimeoutMs: 1000,
      });
      await relayPool.connect();

      // 3. Setup subscription to trigger ping monitor
      relayPool.subscribe([{ kinds: [1] }], () => {});

      // 4. Wait for rebuild to start (ping timeout is 1s)
      await sleep(1500);

      // 5. Disconnect during rebuild - should not throw
      await relayPool.disconnect();

      // 6. Cleanup
      stopUnresponsiveRelay();
    },
    10000,
  );

  test.serial(
    'should restore subscription delivery after relay disconnect/reconnect',
    async () => {
      // 1. Setup signer
      const privateKey = generateSecretKey();
      const privateKeyHex = bytesToHex(privateKey);
      const publicKeyHex = getPublicKey(privateKey);
      const signer = new PrivateKeySigner(privateKeyHex);

      // 2. Setup ApplesauceRelayPool
      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      // 3. Create and sign an event for post-recovery
      const postRecoveryEvent: UnsignedEvent = {
        kind: 1,
        pubkey: publicKeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content:
          'Event published after relay restart to verify subscription restored',
      };
      const postRecoverySignedEvent = await signer.signEvent(postRecoveryEvent);

      // 4. Setup subscription before killing the relay
      const receivedEvents: NostrEvent[] = [];
      const subscriptionPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error('Subscription timeout waiting for post-recovery event'),
            ),
          15000,
        );

        relayPool.subscribe(
          [{ kinds: [1], authors: [publicKeyHex] }],
          (event) => {
            receivedEvents.push(event);
            if (event.id === postRecoverySignedEvent.id) {
              clearTimeout(timeout);
              resolve();
            }
          },
        );
      });

      // Wait for initial EOSE to confirm subscription is active
      await new Promise<void>((resolve) => {
        relayPool.subscribe(
          [{ kinds: [1], limit: 0 }],
          () => {},
          () => resolve(),
        );
        setTimeout(resolve, 1000);
      });

      // 5. Kill the relay to simulate network partition
      stopRelay?.();
      await sleep(2000);

      // 6. Restart the relay to simulate recovery
      const restarted = await spawnMockRelayOnPort(relayPort);
      stopRelay = restarted.stop;

      // 7. Publish event after relay recovery
      await relayPool.publish(postRecoverySignedEvent);

      // 8. Wait for the event to be received via the restored subscription
      await subscriptionPromise;

      // 9. Assertions - verify subscription was actually restored
      expect(receivedEvents.length).toBeGreaterThan(0);
      const receivedEvent = receivedEvents.find(
        (e) => e.id === postRecoverySignedEvent.id,
      );
      expect(receivedEvent).toBeDefined();
      expect(receivedEvent?.content).toBe(postRecoverySignedEvent.content);

      // 10. Cleanup
      relayPool.unsubscribe();
      await relayPool.disconnect();
    },
    DEFAULT_TIMEOUT_MS,
  );

  test.serial(
    'should restore subscription via rebuild when applesauce auto-recovery is disabled',
    async () => {
      // 1. Setup signer using helper
      const { publicKeyHex, signer } = createTestSigner();

      // 2. Start UNRESPONSIVE relay (simulates half-open connection)
      const unresponsiveRelay = await spawnMockRelayWithEnv({
        UNRESPONSIVE: 'true',
      });
      const unresponsiveRelayUrl = unresponsiveRelay.relayUrl;
      const stopUnresponsiveRelay = unresponsiveRelay.stop;

      // 3. Setup pool with FAST ping and DISABLED auto-recovery
      // This forces our rebuild logic to be the only recovery mechanism
      const relayPool = new ApplesauceRelayPool([unresponsiveRelayUrl], {
        pingFrequencyMs: 1000,
        pingTimeoutMs: 1500,
      });

      // Temporarily disable applesauce's auto-recovery for this test
      const testPool = relayPool as unknown as {
        createSubscription: (
          filters: Filter[],
          onEvent: (event: NostrEvent) => void,
          onEose?: () => void,
        ) => () => void;
        relayGroup: RelayGroup;
      };
      testPool.createSubscription = function (filters, onEvent, onEose) {
        // Mirror production shape: subscribe to the raw req() message stream so
        // the test override exercises the same dispatch path as the pool. No
        // dedup (see production createSubscription for rationale).
        const sub = testPool.relayGroup
          .req(filters, {
            reconnect: false, // Disable applesauce recovery
            resubscribe: false, // Disable applesauce recovery
          })
          .subscribe({
            next: (message) => {
              if (message.type === 'EOSE') {
                onEose?.();
                return;
              }

              if (message.type === 'EVENT') {
                onEvent(message.event);
              }
            },
            error: () => {},
          });

        return () => sub.unsubscribe();
      };

      await relayPool.connect();

      // 4. Setup subscription and track events
      const receivedEvents: NostrEvent[] = [];
      const subscriptionPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                'Subscription timeout - rebuild did not restore subscription',
              ),
            ),
          TIMING.SUBSCRIPTION_TIMEOUT,
        );

        relayPool.subscribe(
          [{ kinds: [1], authors: [publicKeyHex] }],
          (event) => {
            receivedEvents.push(event);
            if (event.id === testEventId) {
              clearTimeout(timeout);
              resolve();
            }
          },
        );
      });

      // 5. Wait for ping timeout to trigger rebuild
      await sleep(4000);

      // 6. Create and publish test event after rebuild
      const testEvent: UnsignedEvent = {
        kind: 1,
        pubkey: publicKeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'Test event after rebuild with auto-recovery disabled',
      };
      const testSignedEvent = await signer.signEvent(testEvent);
      const testEventId = testSignedEvent.id;

      await relayPool.publish(testSignedEvent);

      // 7. Wait for event via restored subscription
      await subscriptionPromise;

      // 8. Assertions - verify subscription was restored by OUR rebuild logic
      expect(receivedEvents.length).toBeGreaterThan(0);
      const receivedEvent = receivedEvents.find((e) => e.id === testEventId);
      expect(receivedEvent).toBeDefined();
      expect(receivedEvent?.content).toBe(testSignedEvent.content);

      // 9. Verify descriptors were preserved
      const internalState = getInternalState(relayPool);
      expect(internalState.subscriptions.size).toBeGreaterThan(0);

      // 10. Cleanup
      relayPool.unsubscribe();
      await relayPool.disconnect();
      stopUnresponsiveRelay();
    },
    15000,
  );

  test('should trigger rebuild when no relays can connect (non-existent relay URL)', async () => {
    // 1. Use a non-existent relay URL (nothing listening on this port)
    const nonExistentRelayUrl = 'ws://localhost:19999';

    // 2. Setup ApplesauceRelayPool with fast ping for testing
    const relayPool = new ApplesauceRelayPool([nonExistentRelayUrl], {
      pingFrequencyMs: 500,
      pingTimeoutMs: 1000,
    });

    await relayPool.connect();

    // 3. Track rebuild calls using helper
    const rebuildTracker = trackRebuildCalls(relayPool);

    // 4. Start subscription to activate ping monitor
    relayPool.subscribe([PING_FILTER], () => {});

    // 5. Wait for liveness check to detect no connected relays
    await sleep(TIMING.REBUILD_WAIT);

    // 6. Verify rebuild was triggered because no relays could connect
    expect(rebuildTracker.calls.length).toBeGreaterThan(0);
    expect(rebuildTracker.calls[0]?.reason).toBe('no-connected-relays');

    // 7. Cleanup
    rebuildTracker.restore();
    relayPool.unsubscribe();
    await relayPool.disconnect();
  }, 10000);

  test.serial(
    'should detect half-open connection, rebuild, and recover when relay becomes responsive',
    async () => {
      // 1. Setup signer for publishing using helper
      const { publicKeyHex, signer } = createTestSigner();

      // 2. Start an unresponsive relay
      const unresponsiveRelaySpawn = await spawnMockRelayWithEnv({
        UNRESPONSIVE: 'true',
      });
      const relayPort = unresponsiveRelaySpawn.port;
      const relayUrl = unresponsiveRelaySpawn.relayUrl;
      const stopUnresponsiveRelay = unresponsiveRelaySpawn.stop;

      // 3. Setup ApplesauceRelayPool with fast ping for testing
      const relayPool = new ApplesauceRelayPool([relayUrl], {
        pingFrequencyMs: 500,
        pingTimeoutMs: 1000,
      });
      await relayPool.connect();

      // 4. Track rebuild calls using helper
      const rebuildTracker = trackRebuildCalls(relayPool);

      // 5. Start subscription to activate ping monitor
      relayPool.subscribe([{ kinds: [1] }], () => {});

      // 6. Wait for first rebuild
      await sleep(TIMING.REBUILD_WAIT);
      expect(rebuildTracker.calls.length).toBeGreaterThan(0);

      // 7. Kill unresponsive relay
      stopUnresponsiveRelay();
      await sleep(TIMING.SHORT_WAIT);

      // 8. Start responsive relay on same port
      const responsiveRelaySpawn = await spawnMockRelayOnPort(relayPort);
      const stopResponsiveRelay = responsiveRelaySpawn.stop;

      // 9. Create and publish an event to verify functionality is restored
      const testEvent: UnsignedEvent = {
        kind: 1,
        pubkey: publicKeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: 'Test event after recovery from half-open connection',
      };
      const testSignedEvent = await signer.signEvent(testEvent);

      // 10. Track received events
      const receivedEvents: NostrEvent[] = [];
      const eventReceivedPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timeout waiting for event after recovery')),
          TIMING.SUBSCRIPTION_TIMEOUT,
        );

        relayPool.subscribe(
          [{ kinds: [1], authors: [publicKeyHex] }],
          (event) => {
            receivedEvents.push(event);
            if (event.id === testSignedEvent.id) {
              clearTimeout(timeout);
              resolve();
            }
          },
        );
      });

      // 11. Publish the event
      await relayPool.publish(testSignedEvent);

      // 12. Wait for event to be received via restored subscription
      await eventReceivedPromise;

      // 13. Assertions
      expect(rebuildTracker.calls.length).toBeGreaterThan(0);
      expect(receivedEvents.length).toBeGreaterThan(0);
      const receivedEvent = receivedEvents.find(
        (e) => e.id === testSignedEvent.id,
      );
      expect(receivedEvent).toBeDefined();
      expect(receivedEvent?.content).toBe(testSignedEvent.content);

      // 14. Cleanup
      rebuildTracker.restore();
      relayPool.unsubscribe();
      await relayPool.disconnect();
      stopResponsiveRelay();
    },
    DEFAULT_TIMEOUT_MS,
  );

  test('should detect relay becoming unresponsive and trigger rebuild', async () => {
    // 1. Start relay in UNRESPONSIVE mode (half-open connection)
    const relay = await spawnMockRelayWithEnv({
      UNRESPONSIVE: 'true',
      DISABLE_MOCK_RESPONSES: 'true',
    });
    const relayUrl = relay.relayUrl;

    // 2. Setup pool with fast ping
    const relayPool = new ApplesauceRelayPool([relayUrl], {
      pingFrequencyMs: 500,
      pingTimeoutMs: 1000,
    });
    await relayPool.connect();

    // 3. Track rebuild calls using helper
    const rebuildTracker = trackRebuildCalls(relayPool);

    // 4. Start subscription to activate ping monitor
    relayPool.subscribe([{ kinds: [1] }], () => {});

    // 5. Wait for liveness check to detect issue
    await sleep(TIMING.REBUILD_WAIT);

    // 6. Verify rebuild was triggered (reason can be either 'no-connected-relays' or 'liveness-timeout'
    // depending on whether the relay manages to connect before becoming unresponsive)
    expect(rebuildTracker.calls.length).toBeGreaterThan(0);
    expect(['liveness-timeout']).toContain(rebuildTracker.calls[0]?.reason);

    // 7. Cleanup
    rebuildTracker.restore();
    relayPool.unsubscribe();
    await relayPool.disconnect();
    relay.stop();
  }, 10000);
});

describe('ApplesauceRelayPool configuration', () => {
  test('passes supported relayOptions through to underlying Relay instances', () => {
    const pool = new ApplesauceRelayPool(['ws://localhost:1234'], {
      relayOptions: {
        eventTimeout: 2_345,
        publishTimeout: 3_456,
      },
    });

    const relay = (
      pool as unknown as {
        relays: Relay[];
      }
    ).relays[0];

    // eoseTimeout was removed in applesauce-relay 6.0.3; eventTimeout and
    // publishTimeout still round-trip cleanly through RelayOptions.
    expect(relay.eventTimeout).toBe(2_345);
    expect(relay.publishTimeout).toBe(3_456);

    pool.unsubscribe();
  });
});
