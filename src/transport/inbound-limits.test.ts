import { expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { BaseNostrTransport } from './base-nostr-transport.js';

class TestTransport extends BaseNostrTransport {
  public listen(onEvent: () => void): Promise<void> {
    return this.subscribe([{ kinds: [1] }], onEvent);
  }

  public async close(): Promise<void> {
    this.unsubscribeAll();
    await this.taskQueue.shutdown();
  }
}

test('drops oversized ASCII and UTF-8 payloads before invoking event processing', async () => {
  const hub = new MockRelayHub();
  const transport = new TestTransport('inbound-limit-test', {
    signer: '1'.repeat(64),
    relayHandler: hub.createRelayHandler(),
  });
  let calls = 0;
  await transport.listen(() => {
    calls++;
  });
  try {
    for (const content of [
      'a'.repeat(1024 * 1024 + 1),
      '€'.repeat(400000),
      'safe',
    ]) {
      hub.publish(
        finalizeEvent(
          { kind: 1, created_at: 1, tags: [], content },
          generateSecretKey(),
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  } finally {
    await transport.close();
  }
});
