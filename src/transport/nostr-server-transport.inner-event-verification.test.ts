import { describe, it, expect, mock } from 'bun:test';
import type { RelayHandler } from '../core/interfaces.js';
import type { NostrEvent } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { NostrServerTransport } from './nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { GIFT_WRAP_KIND } from '../core/constants.js';

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

/**
 * Helper: creates a cryptographically valid inner event using a real keypair.
 */
function createValidInnerEvent(
  secretKey: Uint8Array,
  content: string,
  serverPubkey: string,
): NostrEvent {
  return finalizeEvent(
    {
      kind: 25910,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', serverPubkey]],
      content,
    },
    secretKey,
  );
}

/**
 * Helper: creates a forged inner event with a valid id but garbage signature.
 */
function createForgedInnerEvent(
  secretKey: Uint8Array,
  content: string,
  serverPubkey: string,
): NostrEvent {
  const valid = createValidInnerEvent(secretKey, content, serverPubkey);
  return {
    ...valid,
    sig: '0'.repeat(128),
  };
}

describe.serial('Inner event signature verification (fixes #64)', () => {
  it('rejects a decrypted inner event with an invalid signature', async () => {
    const serverSk = generateSecretKey();
    const serverPubkey = getPublicKey(serverSk);

    const whitelistedSk = generateSecretKey();
    const whitelistedPubkey = getPublicKey(whitelistedSk);

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(Buffer.from(serverSk).toString('hex')),
      relayHandler: makeNoopRelayHandler(),
      encryptionMode: EncryptionMode.REQUIRED,
      allowedPublicKeys: [whitelistedPubkey],
    });

    // Track onmessage calls — should never fire for a forged event.
    const onmessageSpy = mock(() => {});
    transport.onmessage = onmessageSpy;

    // Forge an inner event with a whitelisted pubkey but garbage signature.
    const forgedInner = createForgedInnerEvent(
      whitelistedSk,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
      serverPubkey,
    );

    // Stub decryption to return the forged inner event.
    const signer = transport['signer'];
    signer.nip44 = {
      encrypt: async () => {
        throw new Error('encrypt not used');
      },
      decrypt: async () => JSON.stringify(forgedInner),
    };

    const gw: NostrEvent = {
      id: 'gw-forged',
      kind: GIFT_WRAP_KIND,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      tags: [['p', serverPubkey]],
      content: 'ciphertext',
      sig: '0'.repeat(128),
    };

    await transport['processIncomingEvent'](gw);

    // The forged event must be rejected — onmessage should never be called.
    expect(onmessageSpy).not.toHaveBeenCalled();
  });

  it('accepts a decrypted inner event with a valid signature', async () => {
    const serverSk = generateSecretKey();
    const serverPubkey = getPublicKey(serverSk);

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(Buffer.from(serverSk).toString('hex')),
      relayHandler: makeNoopRelayHandler(),
      encryptionMode: EncryptionMode.REQUIRED,
    });

    // Create a legitimate inner event with a real key.
    const clientSk = generateSecretKey();
    const validInner = createValidInnerEvent(
      clientSk,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
      serverPubkey,
    );

    // Stub decryption to return the valid inner event.
    const signer = transport['signer'];
    signer.nip44 = {
      encrypt: async () => {
        throw new Error('encrypt not used');
      },
      decrypt: async () => JSON.stringify(validInner),
    };

    const gw: NostrEvent = {
      id: 'gw-valid',
      kind: GIFT_WRAP_KIND,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      tags: [['p', serverPubkey]],
      content: 'ciphertext',
      sig: '0'.repeat(128),
    };

    await transport['processIncomingEvent'](gw);

    // The valid event should be processed — check correlation store has the route.
    const state = transport.getInternalStateForTesting();
    expect(state.correlationStore.eventRouteCount).toBe(1);
  });
});
