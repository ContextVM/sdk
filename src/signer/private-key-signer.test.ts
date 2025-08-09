import { test, expect, beforeAll, describe } from 'bun:test';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  type UnsignedEvent,
} from 'nostr-tools';
import { PrivateKeySigner } from './private-key-signer.js';

describe('PrivateKeySigner', () => {
  const privateKey = generateSecretKey();
  const privateKeyHex = bytesToHex(privateKey);
  const publicKeyHex = getPublicKey(privateKey);
  let signer: PrivateKeySigner;

  beforeAll(() => {
    signer = new PrivateKeySigner(privateKeyHex);
  });

  test('constructor correctly initializes privateKey and publicKey', async () => {
    expect(signer['privateKey']).toEqual(hexToBytes(privateKeyHex));
    expect(await signer.getPublicKey()).toBe(publicKeyHex);
  });

  test('constructor correctly initializes privateKey and publicKey from undefined privateKey', async () => {
    const undefinedSigner = new PrivateKeySigner();
    expect(await undefinedSigner.getPublicKey()).toBeDefined();
  });

  test('nip44 encrypt and decrypt work correctly', async () => {
    const anotherPrivateKey = generateSecretKey();
    const anotherPublicKey = getPublicKey(anotherPrivateKey);
    const anotherSigner = new PrivateKeySigner(bytesToHex(anotherPrivateKey));

    const plaintext = 'Hello Encryption!';

    // Test encryption from signer to another
    const ciphertext = await signer.nip44!.encrypt(anotherPublicKey, plaintext);
    expect(typeof ciphertext).toBe('string');
    expect(ciphertext).not.toBe(plaintext);

    // Test decryption from another signer
    const decrypted = await anotherSigner.nip44!.decrypt(
      publicKeyHex,
      ciphertext,
    );
    expect(decrypted).toBe(plaintext);
  });

  test('getPublicKey() returns the correct public key', async () => {
    const publicKey = await signer.getPublicKey();
    expect(publicKey).toBe(publicKeyHex);
  });

  test('signEvent() correctly signs an UnsignedEvent', async () => {
    const unsignedEvent: UnsignedEvent = {
      kind: 1,
      pubkey: publicKeyHex,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'Hello Nostr!',
    };

    const signedEvent = await signer.signEvent(unsignedEvent);

    expect(signedEvent).toEqual(
      finalizeEvent(
        unsignedEvent,
        Uint8Array.from(Buffer.from(privateKeyHex, 'hex')),
      ),
    );
  });
});
