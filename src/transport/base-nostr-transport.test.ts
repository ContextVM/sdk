import { describe, test, expect } from 'bun:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';

describe('BaseNostrTransport signer shorthand', () => {
  const privateKey = generateSecretKey();
  const privateKeyHex = bytesToHex(privateKey);
  const expectedPublicKey = getPublicKey(privateKey);

  test('NostrServerTransport accepts a hex string signer', async () => {
    const transport = new NostrServerTransport({
      signer: privateKeyHex,
      relayHandler: ['wss://unused.example.com'],
    });

    // Constructing without errors validates the instantiation.
    await expect(transport.close()).resolves.toBeUndefined();
  });

  test('NostrServerTransport accepts a NostrSigner instance', async () => {
    const signer = new PrivateKeySigner(privateKeyHex);
    const transport = new NostrServerTransport({
      signer,
      relayHandler: ['wss://unused.example.com'],
    });

    await expect(transport.close()).resolves.toBeUndefined();
  });

  test('NostrClientTransport accepts a hex string signer', async () => {
    const serverKey = bytesToHex(generateSecretKey());
    const serverPubkey = getPublicKey(generateSecretKey());

    const transport = new NostrClientTransport({
      signer: serverKey,
      serverPubkey,
      relayHandler: ['wss://unused.example.com'],
    });

    await expect(transport.close()).resolves.toBeUndefined();
  });

  test('NostrClientTransport accepts a NostrSigner instance', async () => {
    const signer = new PrivateKeySigner(privateKeyHex);
    const serverPubkey = getPublicKey(generateSecretKey());

    const transport = new NostrClientTransport({
      signer,
      serverPubkey,
      relayHandler: ['wss://unused.example.com'],
    });

    await expect(transport.close()).resolves.toBeUndefined();
  });

  test('hex string signer produces correct public key', async () => {
    const signer = new PrivateKeySigner(privateKeyHex);
    const pubkey = await signer.getPublicKey();
    expect(pubkey).toBe(expectedPublicKey);

    const transport = new NostrServerTransport({
      signer: privateKeyHex,
      relayHandler: ['wss://unused.example.com'],
    });

    expect(transport).toBeDefined();
    await transport.close();
  });
});
