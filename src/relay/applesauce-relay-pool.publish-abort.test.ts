import { describe, expect, test } from 'bun:test';
import { ApplesauceRelayPool } from './applesauce-relay-pool.js';
import type { NostrEvent } from 'nostr-tools';

type PublishCallOptions = {
  timeout?: number | boolean;
  retries?: boolean | number;
};

type FakeRelayPublish = (
  event: NostrEvent,
  opts?: PublishCallOptions,
) => Promise<{ ok: boolean; message?: string }>;

/** Error shaped like the rxjs TimeoutError thrown by relay publish ladders. */
function ladderTimeoutError(): Error {
  const error = new Error('Timeout has occurred');
  error.name = 'TimeoutError';
  return error;
}

function makeEvent(idPrefix: string): NostrEvent {
  return {
    id: idPrefix.repeat(64),
    pubkey: 'p'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'test',
    sig: 's'.repeat(128),
  } as unknown as NostrEvent;
}

/** Replaces the pool's relays with fakes exposing per-relay publish(). */
function injectFakeRelays(
  pool: ApplesauceRelayPool,
  publishes: FakeRelayPublish[],
  connected = true,
): void {
  (
    pool as unknown as {
      relays: unknown[];
    }
  ).relays = publishes.map((publish, index) => ({
    url: `ws://relay-${index}.test`,
    connected,
    publish,
  }));
}

describe('ApplesauceRelayPool publish cancellation (regression)', () => {
  test('publish() forwards configured publishOptions to each relay.publish()', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid'], {
      publishOptions: {
        timeout: 1_234,
        retries: 2,
      },
    });

    const received: Array<PublishCallOptions | undefined> = [];
    injectFakeRelays(pool, [
      async (_event, opts) => {
        received.push(opts);
        return { ok: true };
      },
      async (_event, opts) => {
        received.push(opts);
        return { ok: true };
      },
    ]);

    await expect(pool.publish(makeEvent('f'))).resolves.toBeUndefined();
    expect(received).toEqual([
      { timeout: 1_234, retries: 2 },
      { timeout: 1_234, retries: 2 },
    ]);
  });

  test('publish() stops retrying after abortSignal is aborted (prevents zombie loops)', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);

    let publishAttemptCount = 0;

    // Relays whose ladders time out (no answer) force publish() into its retry loop.
    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        return Promise.reject(ladderTimeoutError());
      },
    ]);

    const controller = new AbortController();

    // Abort quickly; publish() may still take up to one retry interval to observe it.
    setTimeout(() => controller.abort(), 10);

    const startMs = Date.now();
    await expect(
      pool.publish(makeEvent('e'), { abortSignal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    const elapsedMs = Date.now() - startMs;

    // Guardrail: it must terminate promptly (i.e., not keep retrying indefinitely).
    expect(elapsedMs).toBeLessThan(2000);

    const attemptsAtAbort = publishAttemptCount;
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));

    // If the retry loop kept running in the background, this number would increase.
    expect(publishAttemptCount).toBe(attemptsAtAbort);
  }, 10_000);

  test('disconnect() cancels in-flight publish retries (lifecycle abort)', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);

    let publishAttemptCount = 0;

    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        return Promise.reject(ladderTimeoutError());
      },
    ]);

    const pending = pool.publish(makeEvent('d'));
    setTimeout(() => void pool.disconnect(), 10);

    await expect(pending).rejects.toThrow(/aborted/i);

    const attemptsAtAbort = publishAttemptCount;
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
    expect(publishAttemptCount).toBe(attemptsAtAbort);
  }, 10_000);

  test('publish() treats zero acknowledgements during rebuild as ambiguous and retries', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);

    let publishAttemptCount = 0;
    let rebuildResolved = false;
    let resolveRebuild!: () => void;
    const rebuildPromise = new Promise<void>((resolve) => {
      resolveRebuild = (): void => {
        rebuildResolved = true;
        resolve();
      };
    });

    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        if (publishAttemptCount === 1) {
          // Simulate a rebuild starting mid-attempt: the attempt observes no
          // explicit relay answer at all.
          (
            pool as unknown as {
              relayGeneration: number;
            }
          ).relayGeneration += 1;
          (
            pool as unknown as {
              rebuildInFlight?: Promise<void>;
            }
          ).rebuildInFlight = rebuildPromise;
          setTimeout(() => {
            (
              pool as unknown as {
                rebuildInFlight?: Promise<void>;
              }
            ).rebuildInFlight = undefined;
            resolveRebuild();
          }, 20);
          return Promise.reject(ladderTimeoutError());
        }

        return Promise.resolve({ ok: true });
      },
    ]);

    await expect(pool.publish(makeEvent('a'))).resolves.toBeUndefined();
    expect(rebuildResolved).toBe(true);
    expect(publishAttemptCount).toBe(2);
  });

  test('publish() does not retry duplicate relay responses once a relay answered', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);
    let publishAttemptCount = 0;

    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        return Promise.resolve({
          ok: false,
          message: 'duplicate: already have this event',
        });
      },
    ]);

    await expect(pool.publish(makeEvent('b'))).rejects.toThrow(
      'Relay rejected publish',
    );
    expect(publishAttemptCount).toBe(1);
  });

  test('publish() does not retry terminal relay rejections like mute', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);
    let publishAttemptCount = 0;

    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        return Promise.resolve({
          ok: false,
          message:
            'mute: no one was listening to your ephemeral event and it was ignored',
        });
      },
    ]);

    await expect(pool.publish(makeEvent('d'))).rejects.toThrow(
      'Relay rejected publish',
    );
    expect(publishAttemptCount).toBe(1);
  });

  test('publish() does not retry unknown negative responses once a connected relay answered', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);
    let publishAttemptCount = 0;

    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        return Promise.resolve({
          ok: false,
          message: 'temporarily unavailable',
        });
      },
    ]);

    await expect(pool.publish(makeEvent('e'))).rejects.toThrow(
      'Relay rejected publish',
    );
    expect(publishAttemptCount).toBe(1);
  });

  test('publish() retries when acknowledgements are missing and no relay answered', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);

    let publishAttemptCount = 0;

    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        if (publishAttemptCount === 1) {
          return Promise.reject(ladderTimeoutError());
        }

        return Promise.resolve({ ok: true });
      },
    ]);

    await expect(pool.publish(makeEvent('c'))).resolves.toBeUndefined();
    expect(publishAttemptCount).toBe(2);
  });
});

describe('ApplesauceRelayPool publish acknowledgement modes', () => {
  test('first-ack (default) resolves on the first accepted OK without waiting for stragglers', async () => {
    const pool = new ApplesauceRelayPool([
      'ws://healthy.test',
      'ws://zombie.test',
    ]);

    let healthyAcks = 0;
    injectFakeRelays(pool, [
      () => {
        healthyAcks += 1;
        return Promise.resolve({ ok: true });
      },
      // Zombie relay: ladder never settles within the test window.
      () => new Promise(() => {}),
    ]);

    // Wait-for-all would hang forever on the never-settling relay.
    const startMs = Date.now();
    await expect(pool.publish(makeEvent('1'))).resolves.toBeUndefined();
    expect(Date.now() - startMs).toBeLessThan(1_000);
    expect(healthyAcks).toBe(1);
  });

  test("ackMode 'all' waits for every relay ladder to settle", async () => {
    const pool = new ApplesauceRelayPool(
      ['ws://healthy.test', 'ws://zombie.test'],
      {
        publishOptions: { ackMode: 'all' },
      },
    );

    let zombieSettledAt = 0;
    injectFakeRelays(pool, [
      () => Promise.resolve({ ok: true }),
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            zombieSettledAt = Date.now();
            reject(ladderTimeoutError());
          }, 150);
        }),
    ]);

    // 'all' mode must not resolve on the instant ack alone: it only settles
    // after the straggler's ladder completed (accepted > 0 wins, as before).
    const startMs = Date.now();
    await expect(pool.publish(makeEvent('2'))).resolves.toBeUndefined();
    expect(zombieSettledAt).toBeGreaterThan(0);
    expect(Date.now() - startMs).toBeGreaterThanOrEqual(140);
  });

  test('a zombie-only pool retries without misreporting relay rejection', async () => {
    const pool = new ApplesauceRelayPool([
      'ws://zombie-1.test',
      'ws://zombie-2.test',
    ]);

    let publishAttemptCount = 0;
    const controller = new AbortController();
    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        // Abort from inside the second attempt so the loop exits deterministically.
        if (publishAttemptCount >= 2) controller.abort();
        return Promise.reject(ladderTimeoutError());
      },
      () => Promise.reject(ladderTimeoutError()),
    ]);

    // Regression pin: timeouts are "no answer", never a fatal relay rejection.
    await expect(
      pool.publish(makeEvent('3'), { abortSignal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(publishAttemptCount).toBe(2);
  }, 10_000);

  test('explicit rejection from one relay is terminal even when the other relay never answered', async () => {
    const pool = new ApplesauceRelayPool([
      'ws://rejecting.test',
      'ws://zombie.test',
    ]);

    let publishAttemptCount = 0;
    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        return Promise.resolve({ ok: false, message: 'blocked: pubkey' });
      },
      // Zombie: ladder times out without ever answering (half-open socket).
      // The rejection must not finish early — but once the ladder settles, the
      // explicit rejection wins without a retry.
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(ladderTimeoutError()), 100);
        }),
    ]);

    await expect(pool.publish(makeEvent('4'))).rejects.toThrow(
      'Relay rejected publish',
    );
    expect(publishAttemptCount).toBe(1);
  });

  test('non-timeout errors on a connected relay are terminal rejections', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);
    let publishAttemptCount = 0;

    injectFakeRelays(pool, [
      () => {
        publishAttemptCount += 1;
        return Promise.reject(
          new Error('auth-required: we need you to authenticate'),
        );
      },
    ]);

    await expect(pool.publish(makeEvent('5'))).rejects.toThrow(
      'Relay rejected publish',
    );
    expect(publishAttemptCount).toBe(1);
  });

  test('non-timeout errors on a disconnected relay are retried, not terminal', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);

    let publishAttemptCount = 0;
    injectFakeRelays(
      pool,
      [
        () => {
          publishAttemptCount += 1;
          if (publishAttemptCount === 1) {
            return Promise.reject(new Error('socket error'));
          }
          return Promise.resolve({ ok: true });
        },
      ],
      false, // relay reports disconnected
    );

    await expect(pool.publish(makeEvent('6'))).resolves.toBeUndefined();
    expect(publishAttemptCount).toBe(2);
  });

  test('an empty relay set is retried as no-answer rather than hanging', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);

    (
      pool as unknown as {
        relays: unknown[];
      }
    ).relays = [];

    // Relays appear before the first retry interval elapses (500ms).
    setTimeout(() => {
      injectFakeRelays(pool, [() => Promise.resolve({ ok: true })]);
    }, 10);

    await expect(pool.publish(makeEvent('7'))).resolves.toBeUndefined();
  }, 10_000);
});
