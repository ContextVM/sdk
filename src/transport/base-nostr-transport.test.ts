import { describe, test, expect } from 'bun:test';
import {
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
  type UnsignedEvent,
} from 'nostr-tools/pure';
import { finalizeEvent } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import {
  CTXVM_MESSAGES_KIND,
  GIFT_WRAP_KIND,
  encryptMessage,
  mcpToNostrEvent,
  type NostrSigner,
} from '../core/index.js';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';

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

class CountingSigner implements NostrSigner {
  public signCount = 0;
  public publicKeyCount = 0;
  private readonly inner: PrivateKeySigner;

  constructor(privateKey: string) {
    this.inner = new PrivateKeySigner(privateKey);
    this.nip44 = this.inner.nip44;
  }

  async getPublicKey(): Promise<string> {
    this.publicKeyCount++;
    return this.inner.getPublicKey();
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    this.signCount++;
    return this.inner.signEvent(event);
  }

  nip44: NostrSigner['nip44'];
}

// Exposes the protected CEP-22 sizing helpers for testing.
class MeasuringClientTransport extends NostrClientTransport {
  publicMeasure(
    message: JSONRPCMessage,
    recipientPublicKey: string,
    kind: number,
    tags?: NostrEvent['tags'],
    isEncrypted?: boolean,
    giftWrapKind?: number,
  ): Promise<number> {
    return this.measurePublishedMcpMessageSize(
      message,
      recipientPublicKey,
      kind,
      tags,
      isEncrypted,
      giftWrapKind,
    );
  }

  publicResolveSafeOversizedChunkSize(params: {
    desiredChunkSizeBytes: number;
    maxPublishedEventBytes: number;
    recipientPublicKey: string;
    kind: number;
    progressToken: string;
    progress: number;
    tags?: NostrEvent['tags'];
    isEncrypted?: boolean;
    giftWrapKind?: number;
  }): Promise<number> {
    return this.resolveSafeOversizedChunkSize(params);
  }
}

describe('measurePublishedMcpMessageSize', () => {
  const secretKey = generateSecretKey();
  const recipient = getPublicKey(generateSecretKey());
  const signer = new CountingSigner(bytesToHex(secretKey));
  const transport = new MeasuringClientTransport({
    signer,
    serverPubkey: recipient,
    relayHandler: ['wss://unused.example.com'],
  });
  const tags = [['p', recipient]];
  const message: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      _meta: { progressToken: 'probe-token' },
      name: 'tool',
      arguments: { payload: 'x'.repeat(2_000) },
    },
  };
  const byteLength = (value: string) =>
    new TextEncoder().encode(value).byteLength;

  test('matches the real signed and gift-wrapped event size without signing', async () => {
    const measured = await transport.publicMeasure(
      message,
      recipient,
      CTXVM_MESSAGES_KIND,
      tags,
      true,
      GIFT_WRAP_KIND,
    );

    const signed = finalizeEvent(
      mcpToNostrEvent(
        message,
        getPublicKey(secretKey),
        CTXVM_MESSAGES_KIND,
        tags,
      ),
      secretKey,
    );
    const wrapped = encryptMessage(
      JSON.stringify(signed),
      recipient,
      GIFT_WRAP_KIND,
    );

    expect(measured).toBe(byteLength(JSON.stringify(wrapped)));
    expect(signer.signCount).toBe(0);
    expect(signer.publicKeyCount).toBe(0);
  });

  test('matches the real signed event size on the unencrypted path', async () => {
    const measured = await transport.publicMeasure(
      message,
      recipient,
      CTXVM_MESSAGES_KIND,
      tags,
      false,
    );

    const signed = finalizeEvent(
      mcpToNostrEvent(
        message,
        getPublicKey(secretKey),
        CTXVM_MESSAGES_KIND,
        tags,
      ),
      secretKey,
    );

    expect(measured).toBe(byteLength(JSON.stringify(signed)));
    expect(signer.signCount).toBe(0);
  });

  test('resolveSafeOversizedChunkSize binary search never touches the signer', async () => {
    const chunkSize = await transport.publicResolveSafeOversizedChunkSize({
      desiredChunkSizeBytes: 8_192,
      maxPublishedEventBytes: 48_000,
      recipientPublicKey: recipient,
      kind: CTXVM_MESSAGES_KIND,
      progressToken: 'probe-token',
      progress: 2,
      tags,
      isEncrypted: true,
      giftWrapKind: GIFT_WRAP_KIND,
    });

    expect(chunkSize).toBeGreaterThan(0);
    expect(signer.signCount).toBe(0);
    expect(signer.publicKeyCount).toBe(0);
  });
});
