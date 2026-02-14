import { describe, expect, test } from 'bun:test';
import { ApplesauceRelayPool } from './applesauce-relay-pool.js';
import type { NostrEvent } from 'nostr-tools';

describe('ApplesauceRelayPool publish cancellation (regression)', () => {
  test('publish() stops retrying after abortSignal is aborted (prevents zombie loops)', async () => {
    const pool = new ApplesauceRelayPool(['ws://example.invalid']);

    let publishAttemptCount = 0;

    // Inject a relayGroup implementation that always fails quickly.
    // This forces ApplesauceRelayPool.publish() into its retry loop.
    (
      pool as unknown as {
        relayGroup: {
          publish: (event: NostrEvent) => Promise<Array<{ ok: boolean }>>;
        };
      }
    ).relayGroup = {
      publish: async (_event: NostrEvent) => {
        publishAttemptCount += 1;
        throw new Error('simulated publish failure');
      },
    };

    const event = {
      id: 'e'.repeat(64),
      pubkey: 'p'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'test',
      sig: 's'.repeat(128),
    } as unknown as NostrEvent;

    const controller = new AbortController();

    // Abort quickly; publish() may still take up to one retry interval to observe it.
    setTimeout(() => controller.abort(), 10);

    const startMs = Date.now();
    await expect(
      pool.publish(event, { abortSignal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    const elapsedMs = Date.now() - startMs;

    // Guardrail: it must terminate promptly (i.e., not keep retrying indefinitely).
    expect(elapsedMs).toBeLessThan(2000);

    const attemptsAtAbort = publishAttemptCount;
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));

    // If the retry loop kept running in the background, this number would increase.
    expect(publishAttemptCount).toBe(attemptsAtAbort);
  }, 10_000);
});
