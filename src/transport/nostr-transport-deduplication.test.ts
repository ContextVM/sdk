import { afterAll, describe, test, expect, mock } from 'bun:test';
import { EncryptionMode, type RelayHandler } from '../core/interfaces.js';
import type { NostrEvent } from 'nostr-tools';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EPHEMERAL_GIFT_WRAP_KIND, GIFT_WRAP_KIND } from '../core/constants.js';
import { NostrServerTransport } from './nostr-server-transport.js';

let decryptCallCount = 0;

// Mock decryptMessage so we can deterministically assert deduplication without a relay.
mock.module('../core/encryption.js', () => {
  return {
    decryptMessage: async () => {
      decryptCallCount += 1;
      return JSON.stringify({
        id: 'inner-event-id',
        kind: 25910,
        pubkey: '0'.repeat(64),
        created_at: 1,
        tags: [],
        content: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/test',
        }),
        sig: '0'.repeat(128),
      } satisfies NostrEvent);
    },
    encryptMessage: (
      message: string,
      recipientPublicKey: string,
    ): NostrEvent => {
      return {
        id: 'mock-giftwrap',
        kind: GIFT_WRAP_KIND,
        content: message,
        tags: [['p', recipientPublicKey]],
        created_at: 1,
        pubkey: '0'.repeat(64),
        sig: '0'.repeat(128),
      } satisfies NostrEvent;
    },
  };
});

afterAll(() => {
  mock.restore();
});

function makeNoopRelayHandler(): RelayHandler {
  return {
    async connect() {},
    async disconnect() {},
    async publish() {},
    async subscribe() {
      return () => {};
    },
  } as unknown as RelayHandler;
}

describe('gift-wrap pre-decrypt deduplication', () => {
  test('client: decrypts only once for duplicate gift-wrap deliveries', async () => {
    decryptCallCount = 0;

    const serverPubkey = '0'.repeat(64);
    const clientPriv = '1'.repeat(64);

    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPriv),
      relayHandler: makeNoopRelayHandler(),
      serverPubkey,
      encryptionMode: EncryptionMode.REQUIRED,
    });

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-id',
      kind: GIFT_WRAP_KIND,
      pubkey: 'f'.repeat(64),
      created_at: 1,
      tags: [['p', '0'.repeat(64)]],
      content: 'ciphertext',
      sig: 'f'.repeat(128),
    };

    await transport['processIncomingEvent'](giftWrap);
    await transport['processIncomingEvent'](giftWrap);

    expect(decryptCallCount).toBe(1);
    expect(received).toHaveLength(1);
  });

  test('client: decrypts ephemeral gift wrap kind as well', async () => {
    decryptCallCount = 0;

    const serverPubkey = '0'.repeat(64);
    const clientPriv = '1'.repeat(64);

    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPriv),
      relayHandler: makeNoopRelayHandler(),
      serverPubkey,
      encryptionMode: EncryptionMode.REQUIRED,
    });

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-ephemeral-id',
      kind: EPHEMERAL_GIFT_WRAP_KIND,
      pubkey: 'f'.repeat(64),
      created_at: 1,
      tags: [['p', '0'.repeat(64)]],
      content: 'ciphertext',
      sig: 'f'.repeat(128),
    };

    await transport['processIncomingEvent'](giftWrap);

    expect(decryptCallCount).toBe(1);
    expect(received).toHaveLength(1);
  });

  test('server: decrypts only once for duplicate gift-wrap deliveries', async () => {
    decryptCallCount = 0;

    const serverPriv = '2'.repeat(64);
    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPriv),
      relayHandler: makeNoopRelayHandler(),
      encryptionMode: EncryptionMode.REQUIRED,
    });

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-id',
      kind: GIFT_WRAP_KIND,
      pubkey: 'e'.repeat(64),
      created_at: 1,
      tags: [['p', '0'.repeat(64)]],
      content: 'ciphertext',
      sig: 'e'.repeat(128),
    };

    await transport['processIncomingEvent'](giftWrap);
    await transport['processIncomingEvent'](giftWrap);

    expect(decryptCallCount).toBe(1);
    // At least one message should have been forwarded from the decrypted inner event.
    expect(received.length).toBe(1);
  });

  test('server: decrypts ephemeral gift wrap kind as well', async () => {
    decryptCallCount = 0;

    const serverPriv = '2'.repeat(64);
    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPriv),
      relayHandler: makeNoopRelayHandler(),
      encryptionMode: EncryptionMode.REQUIRED,
    });

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-ephemeral-id',
      kind: EPHEMERAL_GIFT_WRAP_KIND,
      pubkey: 'e'.repeat(64),
      created_at: 1,
      tags: [['p', '0'.repeat(64)]],
      content: 'ciphertext',
      sig: 'e'.repeat(128),
    };

    await transport['processIncomingEvent'](giftWrap);

    expect(decryptCallCount).toBe(1);
    expect(received.length).toBe(1);
  });
});
