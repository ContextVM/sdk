import { describe, expect, mock, test } from 'bun:test';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import {
  CTXVM_MESSAGES_KIND,
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
} from '../../core/constants.js';
import { encryptMessage } from '../../core/encryption.js';
import { EncryptionMode, GiftWrapMode } from '../../core/interfaces.js';
import { createLogger } from '../../core/utils/logger.js';
import { LruCache } from '../../core/utils/lru-cache.js';
import { PrivateKeySigner } from '../../signer/private-key-signer.js';
import { ServerEventPipeline } from './event-pipeline.js';

const CACHE_CAPACITY = 4;

function relayCopy(event: NostrEvent): NostrEvent {
  return JSON.parse(JSON.stringify(event)) as NostrEvent;
}

async function createFixture() {
  const signer = new PrivateKeySigner();
  const serverPubkey = await signer.getPublicKey();
  const clientKey = generateSecretKey();
  const seenGiftWrapIds = new LruCache<true>(CACHE_CAPACITY);
  const seenEventIds = new Set<string>();
  const decrypt = mock(signer.nip44.decrypt);
  signer.nip44.decrypt = decrypt;
  const onerror = mock((_error: Error): void => {});
  const pipeline = new ServerEventPipeline({
    signer,
    seenGiftWrapIds,
    seenEventIds,
    encryptionMode: EncryptionMode.OPTIONAL,
    giftWrapMode: GiftWrapMode.OPTIONAL,
    logger: createLogger('server-event-pipeline-test', { level: 'silent' }),
    onerror,
  });

  const makeEvent = (
    sequence: number,
    createdAt = 100,
    content = JSON.stringify({
      jsonrpc: '2.0',
      id: sequence,
      method: 'tools/call',
      params: { name: 'counter' },
    }),
  ): NostrEvent =>
    relayCopy(
      finalizeEvent(
        {
          kind: CTXVM_MESSAGES_KIND,
          created_at: createdAt,
          tags: [
            ['p', serverPubkey],
            ['test-sequence', String(sequence)],
          ],
          content,
        },
        clientKey,
      ),
    );

  const wrap = (event: NostrEvent, kind = GIFT_WRAP_KIND): NostrEvent =>
    encryptMessage(JSON.stringify(event), serverPubkey, kind);

  const fillEnvelopeCache = async (): Promise<void> => {
    for (let index = 1; index <= CACHE_CAPACITY + 1; index++) {
      expect(await pipeline.unwrap(wrap(makeEvent(index)))).not.toBeNull();
    }
  };

  return {
    pipeline,
    signer,
    serverPubkey,
    seenGiftWrapIds,
    decrypt,
    onerror,
    makeEvent,
    wrap,
    fillEnvelopeCache,
  };
}

describe('ServerEventPipeline replay protection', () => {
  test.each([GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND])(
    'does not unwrap a verified event again after its kind %i envelope is evicted',
    async (kind) => {
      const fixture = await createFixture();
      const original = fixture.makeEvent(0);
      const envelope = fixture.wrap(original, kind);
      expect((await fixture.pipeline.unwrap(envelope))?.event.id).toBe(
        original.id,
      );

      await fixture.fillEnvelopeCache();
      expect(fixture.seenGiftWrapIds.has(envelope.id)).toBe(false);
      const decryptCalls = fixture.decrypt.mock.calls.length;

      expect(await fixture.pipeline.unwrap(relayCopy(envelope))).toBeNull();
      expect(fixture.decrypt.mock.calls.length).toBe(decryptCalls + 1);
      expect(fixture.onerror).not.toHaveBeenCalled();
    },
  );

  test('rejects an old inner event in a fresh envelope after cache pressure', async () => {
    const fixture = await createFixture();
    const original = fixture.makeEvent(0);
    const firstEnvelope = fixture.wrap(original);
    expect(await fixture.pipeline.unwrap(firstEnvelope)).not.toBeNull();

    await fixture.fillEnvelopeCache();
    const newEnvelope = fixture.wrap(original);
    expect(newEnvelope.id).not.toBe(firstEnvelope.id);
    expect(await fixture.pipeline.unwrap(newEnvelope)).toBeNull();
  });

  test('rejects a previously seen plaintext event after more events than the cache capacity', async () => {
    const fixture = await createFixture();
    const original = fixture.makeEvent(0);
    expect(await fixture.pipeline.unwrap(original)).not.toBeNull();

    for (let index = 1; index <= CACHE_CAPACITY + 1; index++) {
      expect(
        await fixture.pipeline.unwrap(fixture.makeEvent(index)),
      ).not.toBeNull();
    }

    expect(await fixture.pipeline.unwrap(relayCopy(original))).toBeNull();
    expect(fixture.decrypt).not.toHaveBeenCalled();
  });

  test('shares verified identity between plaintext and encrypted delivery after cache pressure', async () => {
    const fixture = await createFixture();
    const plainFirst = fixture.makeEvent(-1);
    const encryptedFirst = fixture.makeEvent(0);
    expect(await fixture.pipeline.unwrap(plainFirst)).not.toBeNull();
    expect(
      await fixture.pipeline.unwrap(fixture.wrap(encryptedFirst)),
    ).not.toBeNull();

    await fixture.fillEnvelopeCache();
    expect(await fixture.pipeline.unwrap(fixture.wrap(plainFirst))).toBeNull();
    expect(await fixture.pipeline.unwrap(relayCopy(encryptedFirst))).toBeNull();
  });

  test('deduplicates an envelope before decryption while its cache entry remains', async () => {
    const fixture = await createFixture();
    const envelope = fixture.wrap(fixture.makeEvent(0));
    const results = await Promise.all([
      fixture.pipeline.unwrap(envelope),
      fixture.pipeline.unwrap(relayCopy(envelope)),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(fixture.decrypt).toHaveBeenCalledTimes(1);
  });

  test('claims an inner identity once when distinct envelopes finish asynchronous decryption together', async () => {
    const fixture = await createFixture();
    const original = fixture.makeEvent(0);
    let releaseDecrypt!: () => void;
    const decryptGate = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    fixture.signer.nip44.decrypt = async (
      pubkey: string,
      ciphertext: string,
    ): Promise<string> => {
      await decryptGate;
      return fixture.decrypt(pubkey, ciphertext);
    };

    const resultsPromise = Promise.all([
      fixture.pipeline.unwrap(fixture.wrap(original)),
      fixture.pipeline.unwrap(fixture.wrap(original)),
    ]);
    expect(fixture.decrypt).not.toHaveBeenCalled();
    releaseDecrypt();

    const results = await resultsPromise;
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(fixture.decrypt).toHaveBeenCalledTimes(2);
    expect(fixture.onerror).not.toHaveBeenCalled();
  });

  test.each(['plain', 'encrypted'] as const)(
    'does not let an invalid %s signature reserve the genuine event identity',
    async (delivery) => {
      const fixture = await createFixture();
      const original = fixture.makeEvent(0);
      const invalid = { ...relayCopy(original), sig: '0'.repeat(128) };
      const deliver = (event: NostrEvent): Promise<unknown> =>
        fixture.pipeline.unwrap(
          delivery === 'encrypted' ? fixture.wrap(event) : event,
        );

      expect(await deliver(invalid)).toBeNull();
      expect(await deliver(relayCopy(original))).not.toBeNull();
      expect(fixture.onerror).not.toHaveBeenCalled();
    },
  );

  test('reports decryption errors without reserving the enclosed event identity', async () => {
    const fixture = await createFixture();
    const original = fixture.makeEvent(0);
    const failure = new Error('signer unavailable');
    fixture.decrypt.mockRejectedValueOnce(failure);

    expect(await fixture.pipeline.unwrap(fixture.wrap(original))).toBeNull();
    expect(fixture.onerror).toHaveBeenCalledTimes(1);
    expect(fixture.onerror).toHaveBeenCalledWith(failure);
    expect(
      await fixture.pipeline.unwrap(fixture.wrap(original)),
    ).not.toBeNull();
  });

  test('reports malformed decrypted JSON and accepts a later valid envelope', async () => {
    const fixture = await createFixture();
    const malformed = encryptMessage('{', fixture.serverPubkey);

    expect(await fixture.pipeline.unwrap(malformed)).toBeNull();
    expect(fixture.onerror).toHaveBeenCalledTimes(1);
    expect(fixture.onerror.mock.calls[0]?.[0]).toBeInstanceOf(SyntaxError);
    expect(
      await fixture.pipeline.unwrap(fixture.wrap(fixture.makeEvent(0))),
    ).not.toBeNull();
  });

  test('accepts distinct signed events with identical payloads in the same second and out of order', async () => {
    const fixture = await createFixture();
    const payload = fixture.makeEvent(0).content;
    const events = [
      fixture.makeEvent(1, 100, payload),
      fixture.makeEvent(2, 100, payload),
      fixture.makeEvent(3, 99, payload),
    ];

    for (const event of events) {
      expect(
        (await fixture.pipeline.unwrap(fixture.wrap(event)))?.event.id,
      ).toBe(event.id);
    }
    expect(fixture.onerror).not.toHaveBeenCalled();
  });

  test.each(['oversized-transfer', 'open-stream'])(
    'retains %s notification frame identities after cache pressure',
    async (type) => {
      const fixture = await createFixture();
      const frame = fixture.makeEvent(
        0,
        100,
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: 'request-stream',
            progress: 1,
            cvm: { type, frameType: 'abort', reason: 'request cancelled' },
          },
        }),
      );
      expect(await fixture.pipeline.unwrap(fixture.wrap(frame))).not.toBeNull();

      await fixture.fillEnvelopeCache();
      expect(await fixture.pipeline.unwrap(fixture.wrap(frame))).toBeNull();
    },
  );
});
