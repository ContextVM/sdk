import { describe, expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import type { NostrEvent } from 'nostr-tools';
import { z } from 'zod';
import { EncryptionMode } from '../core/interfaces.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import type { OpenStreamWriter } from './open-stream/index.js';
import { callToolStream } from './call-tool-stream.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';

// Threshold chosen so the small request payloads (subscribe / big) stay below
// it and are sent as regular events, while the oversized response payload is
// fragmented by the server. This mirrors the realistic configuration where
// oversized transfer fragments large payloads but not handshake/control ones.
const OVERSIZED_THRESHOLD = 1_000;
const OVERSIZED_CHUNK = 500;
const BIG_PAYLOAD_REPEAT = 3_000;

function makeLargeText(prefix: string, repeat: number): string {
  return `${prefix}:${'x'.repeat(repeat)}`;
}

interface CvmFrame {
  type?: string;
  frameType?: string;
}

function getCvmFrame(event: NostrEvent): CvmFrame | undefined {
  try {
    const message = JSON.parse(event.content) as {
      params?: { cvm?: CvmFrame };
    };
    return message.params?.cvm;
  } catch {
    return undefined;
  }
}

interface Fixture {
  relayHub: MockRelayHub;
  server: McpServer;
  client: Client;
  serverTransport: NostrServerTransport;
  clientTransport: NostrClientTransport;
  serverPubkey: string;
}

function createFixture(): Fixture {
  const relayHub = new MockRelayHub();
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
  const clientPrivateKey = bytesToHex(generateSecretKey());

  const server = new McpServer({
    name: 'composition-server',
    version: '1.0.0',
  });

  const serverTransport = new NostrServerTransport({
    signer: new PrivateKeySigner(serverPrivateKey),
    relayHandler: relayHub.createRelayHandler(),
    encryptionMode: EncryptionMode.DISABLED,
    openStream: { enabled: true },
    oversizedTransfer: {
      enabled: true,
      thresholdBytes: OVERSIZED_THRESHOLD,
      chunkSizeBytes: OVERSIZED_CHUNK,
    },
  });

  const clientTransport = new NostrClientTransport({
    signer: new PrivateKeySigner(clientPrivateKey),
    relayHandler: relayHub.createRelayHandler(),
    serverPubkey: serverPublicKey,
    encryptionMode: EncryptionMode.DISABLED,
    openStream: { enabled: true },
    oversizedTransfer: {
      enabled: true,
      thresholdBytes: OVERSIZED_THRESHOLD,
      chunkSizeBytes: OVERSIZED_CHUNK,
    },
  });

  const client = new Client({ name: 'composition-client', version: '1.0.0' });

  return {
    relayHub,
    server,
    client,
    serverTransport,
    clientTransport,
    serverPubkey: serverPublicKey,
  };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fixture.client.close();
  await fixture.server.close();
  fixture.relayHub.clear();
}

describe('open-stream + oversized transfer composition', () => {
  test('an oversized tool response completes while a separate tool is streaming', async () => {
    // Validates that CEP-22 oversized transfers and CEP-41 open streams coexist
    // in one session: a streaming tool holds an active session while a plain
    // (non-streaming) tool returns a payload large enough to fragment as an
    // oversized response. Both features must work independently:
    //   - The big tool's writer is unused, so its response is NOT deferred
    //     (Fix 1) and is instead fragmented/reassembled by the oversized path.
    //   - The big tool's progress token does not steal the stream's session
    //     placeholder (Fix 2), so the live stream keeps delivering.
    const fixture = createFixture();
    let releaseStream: (() => void) | undefined;
    const bigPayload = makeLargeText('big-response', BIG_PAYLOAD_REPEAT);

    fixture.server.registerTool(
      'subscribe',
      {
        title: 'Subscribe',
        description: 'Streams two values across a release latch.',
        inputSchema: { topic: z.string() },
      },
      async ({ topic }, extra) => {
        const stream = (
          extra?._meta as { stream?: OpenStreamWriter } | undefined
        )?.stream;
        if (!stream) {
          throw new Error('stream unavailable');
        }

        await stream.start();
        await stream.write(`first:${topic}`);
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        await stream.write(`second:${topic}`);
        await stream.close();

        return { content: [{ type: 'text', text: `done:${topic}` }] };
      },
    );

    fixture.server.registerTool(
      'big',
      {
        title: 'Big',
        description: 'Returns an oversized response payload.',
        inputSchema: {},
      },
      async () => ({
        content: [{ type: 'text', text: bigPayload }],
      }),
    );

    await fixture.server.connect(fixture.serverTransport);
    await fixture.client.connect(fixture.clientTransport);

    // (1) Start the long-lived streaming subscription and read its first chunk.
    const call = await callToolStream({
      client: fixture.client,
      transport: fixture.clientTransport,
      name: 'subscribe',
      arguments: { topic: 'orders' },
    });

    const iterator = call.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.value).toBe('first:orders');

    // (2) While the stream is active, issue the oversized call. `onprogress`
    //     injects a progress token, which is what routes the response through
    //     the oversized path (and previously also hung it via Part A).
    const bigResult = await fixture.client.callTool(
      { name: 'big', arguments: {} },
      undefined,
      {
        onprogress: () => undefined,
        resetTimeoutOnProgress: true,
      },
    );

    const typedResult = bigResult as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(typedResult.content[0]).toMatchObject({ type: 'text' });
    expect(typedResult.content[0]?.text).toBe(bigPayload);

    // (3) The oversized path must actually have fragmented the response. A
    //     fully-reassembled large payload only arrives if start/chunk/end
    //     frames were sent and reassembled.
    const serverFrames = fixture.relayHub
      .getEvents()
      .filter((event) => event.pubkey === fixture.serverPubkey)
      .map((event) => getCvmFrame(event))
      .filter((cvm): cvm is CvmFrame => cvm?.type === 'oversized-transfer')
      .map((cvm) => cvm.frameType);

    expect(serverFrames).toContain('start');
    expect(serverFrames.filter((t) => t === 'chunk').length).toBeGreaterThan(0);
    expect(serverFrames[serverFrames.length - 1]).toBe('end');

    // (4) The streaming session is unaffected: it still delivers its remaining
    //     chunk, closes, and resolves its final result.
    releaseStream?.();

    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value?.value).toBe('second:orders');

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'done:orders' }],
    });

    await cleanup(fixture);
  }, 15_000);
});
