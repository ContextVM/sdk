import { describe, expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { type JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { CTXVM_MESSAGES_KIND } from '../core/constants.js';
import { EncryptionMode } from '../core/interfaces.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERSIZED_THRESHOLD,
} from './oversized-transfer/constants.js';

function makeLargeText(prefix: string, repeatCount: number): string {
  return `${prefix}:${'x'.repeat(repeatCount)}`;
}

/**
 * Exposes the protected oversized-sizing helpers for direct unit testing.
 */
class InspectableNostrClientTransport extends NostrClientTransport {
  public async resolveChunkSizeForTesting(params: {
    desiredChunkSizeBytes: number;
    thresholdBytes: number;
    progressToken: string;
  }): Promise<number> {
    return this.resolveSafeOversizedChunkSize({
      desiredChunkSizeBytes: params.desiredChunkSizeBytes,
      maxPublishedEventBytes: params.thresholdBytes,
      recipientPublicKey: this['serverPubkey'],
      kind: CTXVM_MESSAGES_KIND,
      progressToken: params.progressToken,
      progress: 2,
      tags: this['createRecipientTags'](this['serverPubkey']),
      giftWrapKind: this['chooseOutboundGiftWrapKind'](),
    });
  }

  public async measureOutboundSizeForTesting(
    message: JSONRPCMessage,
  ): Promise<number> {
    return this.measurePublishedMcpMessageSize(
      message,
      this['serverPubkey'],
      CTXVM_MESSAGES_KIND,
      this['createRecipientTags'](this['serverPubkey']),
      undefined,
      this['chooseOutboundGiftWrapKind'](),
    );
  }
}

describe('oversized transfer under gift-wrap encryption', () => {
  describe('resolveSafeOversizedChunkSize', () => {
    // Regression for docs/ISSUE-oversized-transfer-gift-wrap-broken.md (Fix 1):
    // the chunk-size binary search probes by NIP-44-encrypting a worst-case
    // backslash payload. Before the fix, the first probe exceeded NIP-44's
    // 65 535-byte plaintext cap, nip44.encrypt threw, and there was no
    // try/catch — so the search aborted and oversized responses never
    // fragmented under encryption. The search must instead treat such a throw
    // as "probe too large" and converge.
    test('converges (instead of throwing) when encryption rejects oversized probes', async () => {
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

      const transport = new InspectableNostrClientTransport({
        signer: new PrivateKeySigner(clientPrivateKey),
        // ApplesauceRelayPool is unused — the sizing helpers never publish.
        relayHandler: ['wss://unused.example.com'],
        serverPubkey: serverPublicKey,
        encryptionMode: EncryptionMode.OPTIONAL,
      });

      // With the defaults (desired = threshold = 48 000), the first binary
      // search probe (24 000 backslashes, ~4× expansion under JSON escaping +
      // NIP-44) exceeds the 65 535-byte plaintext cap.
      const chunkSizeBytes = await transport.resolveChunkSizeForTesting({
        desiredChunkSizeBytes: DEFAULT_CHUNK_SIZE,
        thresholdBytes: DEFAULT_OVERSIZED_THRESHOLD,
        progressToken: 'enc-chunk-regression',
      });

      // Must converge to a finite, positive budget.
      expect(Number.isFinite(chunkSizeBytes)).toBe(true);
      expect(chunkSizeBytes).toBeGreaterThan(0);

      // And the resolved size must actually produce a publishable encrypted
      // event at or below the threshold — the whole point of the search.
      const probeFrame: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: 'enc-chunk-regression',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'chunk',
            data: makeLargeText('chunk', chunkSizeBytes),
          },
        },
      };
      const publishedSize =
        await transport.measureOutboundSizeForTesting(probeFrame);

      expect(publishedSize).toBeLessThanOrEqual(DEFAULT_OVERSIZED_THRESHOLD);

      await transport.close();
    });
  });

  describe('encrypted oversized response (end-to-end)', () => {
    // Regression for docs/ISSUE-oversized-transfer-gift-wrap-broken.md (Fix 1 +
    // Fix 2 + integration): an encrypted server response exceeding the
    // oversized threshold must fragment and reassemble. Before the fixes, the
    // gate measurement (Fix 2) or the chunk-size search (Fix 1) threw on
    // NIP-44's plaintext cap, the throw was swallowed by the SDK's
    // fire-and-forget send(), and the client timed out with no oversized
    // frames published.
    test('fragments and reassembles a server response exceeding the threshold', async () => {
      const relayHub = new MockRelayHub();
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());

      const server = new McpServer({
        name: 'oversized-enc-server',
        version: '1.0.0',
      });
      // Payload is large enough to trigger BOTH failure points documented in
      // the issue: (1) the gate measurement of the full response exceeds
      // NIP-44's 65 535-byte plaintext cap (inner plaintext ≈ payload + ~330 B
      // of JSON/event framing), and (2) the chunk-size binary search's first
      // probe (24 000 backslashes × ~4× escaping) also exceeds the cap. 66 000
      // bytes comfortably clears (1) and is well above the 48 000-byte
      // oversized threshold that activates fragmentation.
      const bigPayload = makeLargeText('big', 66_000);
      server.registerTool(
        'big',
        {
          title: 'Big',
          description: 'Returns an oversized response payload.',
          inputSchema: {},
        },
        async () => ({ content: [{ type: 'text', text: bigPayload }] }),
      );

      const serverTransport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: relayHub.createRelayHandler(),
        encryptionMode: EncryptionMode.OPTIONAL,
        oversizedTransfer: { enabled: true },
      });

      const clientTransport = new NostrClientTransport({
        signer: new PrivateKeySigner(clientPrivateKey),
        relayHandler: relayHub.createRelayHandler(),
        serverPubkey: serverPublicKey,
        encryptionMode: EncryptionMode.OPTIONAL,
        oversizedTransfer: { enabled: true },
      });

      await server.connect(serverTransport);
      const client = new Client({
        name: 'oversized-enc-client',
        version: '1.0.0',
      });
      await client.connect(clientTransport);

      // Snapshot event count after handshake, before the oversized call.
      const eventsBeforeCall = relayHub.getEvents().length;

      // onprogress injects a progress token, which routes the response through
      // the proactive oversized path — the path that broke under encryption.
      const result = await client.callTool(
        { name: 'big', arguments: {} },
        undefined,
        { onprogress: () => undefined, resetTimeoutOnProgress: true },
      );

      // The full payload must be reassembled byte-for-byte.
      const content = result.content as unknown as {
        type: string;
        text: string;
      }[];
      expect(content[0]).toMatchObject({ type: 'text' });
      expect(content[0].text).toBe(bigPayload);

      // Under encryption the frames are gift-wrapped (opaque content), so
      // frame types cannot be parsed. Instead, count the gift-wrap events the
      // server published for this response: a fragmented oversized transfer
      // emits start + N chunks + end (>= 3 events), whereas a single
      // unfragmented response would emit exactly one. A 48 KB payload chunked
      // at the NIP-44-safe budget resolves to multiple chunks.
      const responseEvents = relayHub
        .getEvents()
        .slice(eventsBeforeCall)
        .filter((event) => event.kind === 1059 || event.kind === 21059);

      expect(responseEvents.length).toBeGreaterThanOrEqual(3);

      await client.close();
      await server.close();
      relayHub.clear();
    }, 15_000);
  });
});
