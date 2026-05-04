import { describe, test, expect } from 'bun:test';
import { EncryptionMode, type RelayHandler } from '../core/interfaces.js';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EPHEMERAL_GIFT_WRAP_KIND, GIFT_WRAP_KIND } from '../core/constants.js';
import { NostrServerTransport } from './nostr-server-transport.js';

let decryptCallCount = 0;

/**
 * Creates a cryptographically valid inner event so verifyEvent passes.
 * When signerSk is provided, the event is signed by that key (useful for
 * client tests where the inner event must come from the server keypair).
 */
function createValidInnerEvent(
  serverPubkey: string,
  signerSk?: Uint8Array,
): NostrEvent {
  const sk = signerSk ?? generateSecretKey();
  return finalizeEvent(
    {
      kind: 25910,
      created_at: 1,
      tags: [['p', serverPubkey]],
      content: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/test',
      }),
    },
    sk,
  );
}

function installDeterministicDecrypt(
  transport: {
    signer: {
      nip44: {
        encrypt: (plaintext: string, pubkey: string) => Promise<string>;
        decrypt: (ciphertext: string, pubkey: string) => Promise<string>;
      };
    };
  },
  innerEvent: NostrEvent,
): void {
  transport.signer.nip44 = {
    encrypt: async () => {
      throw new Error('encrypt not used in this test');
    },
    decrypt: async () => {
      decryptCallCount += 1;
      return JSON.stringify(innerEvent);
    },
  };
}

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

    // Use a real server keypair so the inner event pubkey matches serverPubkey.
    const serverSk = generateSecretKey();
    const serverPubkey = getPublicKey(serverSk);
    const clientPriv = '1'.repeat(64);

    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPriv),
      relayHandler: makeNoopRelayHandler(),
      serverPubkey,
      encryptionMode: EncryptionMode.REQUIRED,
    });

    // Sign the inner event with the server's key so pubkey matches.
    const innerEvent = createValidInnerEvent(serverPubkey, serverSk);
    installDeterministicDecrypt(
      transport as unknown as {
        signer: {
          nip44: {
            encrypt: (plaintext: string, pubkey: string) => Promise<string>;
            decrypt: (ciphertext: string, pubkey: string) => Promise<string>;
          };
        };
      },
      innerEvent,
    );

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-id',
      kind: GIFT_WRAP_KIND,
      pubkey: 'f'.repeat(64),
      created_at: 1,
      tags: [['p', serverPubkey]],
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

    // Use a real server keypair so the inner event pubkey matches serverPubkey.
    const serverSk = generateSecretKey();
    const serverPubkey = getPublicKey(serverSk);
    const clientPriv = '1'.repeat(64);

    const transport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPriv),
      relayHandler: makeNoopRelayHandler(),
      serverPubkey,
      encryptionMode: EncryptionMode.REQUIRED,
    });

    // Sign the inner event with the server's key so pubkey matches.
    const innerEvent = createValidInnerEvent(serverPubkey, serverSk);
    installDeterministicDecrypt(
      transport as unknown as {
        signer: {
          nip44: {
            encrypt: (plaintext: string, pubkey: string) => Promise<string>;
            decrypt: (ciphertext: string, pubkey: string) => Promise<string>;
          };
        };
      },
      innerEvent,
    );

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-ephemeral-id',
      kind: EPHEMERAL_GIFT_WRAP_KIND,
      pubkey: 'f'.repeat(64),
      created_at: 1,
      tags: [['p', serverPubkey]],
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
    const serverPubkey = getPublicKey(
      Uint8Array.from(Buffer.from(serverPriv, 'hex')),
    );
    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPriv),
      relayHandler: makeNoopRelayHandler(),
      encryptionMode: EncryptionMode.REQUIRED,
    });

    const innerEvent = createValidInnerEvent(serverPubkey);
    installDeterministicDecrypt(
      transport as unknown as {
        signer: {
          nip44: {
            encrypt: (plaintext: string, pubkey: string) => Promise<string>;
            decrypt: (ciphertext: string, pubkey: string) => Promise<string>;
          };
        };
      },
      innerEvent,
    );

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-id',
      kind: GIFT_WRAP_KIND,
      pubkey: 'e'.repeat(64),
      created_at: 1,
      tags: [['p', serverPubkey]],
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
    const serverPubkey = getPublicKey(
      Uint8Array.from(Buffer.from(serverPriv, 'hex')),
    );
    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPriv),
      relayHandler: makeNoopRelayHandler(),
      encryptionMode: EncryptionMode.REQUIRED,
    });

    const innerEvent = createValidInnerEvent(serverPubkey);
    installDeterministicDecrypt(
      transport as unknown as {
        signer: {
          nip44: {
            encrypt: (plaintext: string, pubkey: string) => Promise<string>;
            decrypt: (ciphertext: string, pubkey: string) => Promise<string>;
          };
        };
      },
      innerEvent,
    );

    const received: unknown[] = [];
    transport.onmessage = (msg) => received.push(msg);

    const giftWrap: NostrEvent = {
      id: 'giftwrap-ephemeral-id',
      kind: EPHEMERAL_GIFT_WRAP_KIND,
      pubkey: 'e'.repeat(64),
      created_at: 1,
      tags: [['p', serverPubkey]],
      content: 'ciphertext',
      sig: 'e'.repeat(128),
    };

    await transport['processIncomingEvent'](giftWrap);

    expect(decryptCallCount).toBe(1);
    expect(received.length).toBe(1);
  });
});
