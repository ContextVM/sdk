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

// Low threshold so a moderately large tool *argument* fragments the published
// request event (CEP-22), while control/handshake traffic stays under it. This
// is the configuration that exposes the bug: an open-stream tool reached via an
// oversized request must still observe `extra._meta.stream`. The chunk size
// sits below the threshold so each frame fits in a single published event.
const OVERSIZED_THRESHOLD = 1_000;
const OVERSIZED_CHUNK = 500;
const LARGE_ARGUMENT_REPEAT = 3_000;

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

/** Extracts the sub-frame types (`start`/`chunk`/`end`/…) for a given transport marker. */
function extractFrameTypes(
  events: NostrEvent[],
  transportType: string,
): string[] {
  return events
    .map((event) => getCvmFrame(event))
    .filter((cvm): cvm is CvmFrame => cvm?.type === transportType)
    .map((cvm) => cvm.frameType)
    .filter((t): t is string => typeof t === 'string');
}

interface Fixture {
  relayHub: MockRelayHub;
  server: McpServer;
  client: Client;
  serverTransport: NostrServerTransport;
  clientTransport: NostrClientTransport;
  clientPubkey: string;
  serverPubkey: string;
}

function createFixture(): Fixture {
  const relayHub = new MockRelayHub();
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
  const clientPrivateKey = bytesToHex(generateSecretKey());

  const server = new McpServer({
    name: 'oversized-request-server',
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

  const client = new Client({
    name: 'oversized-request-client',
    version: '1.0.0',
  });

  return {
    relayHub,
    server,
    client,
    serverTransport,
    clientTransport,
    clientPubkey: getPublicKey(hexToBytes(clientPrivateKey)),
    serverPubkey: serverPublicKey,
  };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fixture.client.close();
  await fixture.server.close();
  fixture.relayHub.clear();
}

describe('open-stream tool invoked through an oversized (CEP-22) request', () => {
  test('stream is attached and frames flow when the request is fragmented', async () => {
    // Regression for docs/ISSUE-open-stream-oversized-request-no-stream.md.
    // A `callToolStream` whose published request exceeds the oversized
    // threshold is fragmented start/chunk/end by the client and reassembled on
    // the server by InboundNotificationDispatcher, which re-injects it via
    // handleIncomingRequest. The writer must be attached on that path too —
    // otherwise the tool observes `extra._meta.stream === undefined` and cannot
    // stream, while the response is sent normally (no hang).
    const fixture = createFixture();

    fixture.server.registerTool(
      'subscribe',
      {
        title: 'Subscribe',
        description: 'Streams two chunks, echoing the inbound filter prefix.',
        inputSchema: { filter: z.string() },
      },
      async ({ filter }, extra) => {
        const stream = (
          extra?._meta as { stream?: OpenStreamWriter } | undefined
        )?.stream;
        if (!stream) {
          throw new Error('stream unavailable');
        }

        await stream.start();
        await stream.write(`ack:${filter.slice(0, 8)}`);
        await stream.write('done');
        await stream.close();

        return { content: [{ type: 'text', text: 'completed' }] };
      },
    );

    await fixture.server.connect(fixture.serverTransport);
    await fixture.client.connect(fixture.clientTransport);

    // Large argument forces the published request event over the oversized
    // threshold, routing it through CEP-22 fragmentation.
    const call = await callToolStream({
      client: fixture.client,
      transport: fixture.clientTransport,
      name: 'subscribe',
      arguments: { filter: 'x'.repeat(LARGE_ARGUMENT_REPEAT) },
    });

    // (1) Streamed chunks arrive and the final result resolves.
    const iterator = call.stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.value).toBe('ack:xxxxxxxx');

    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value?.value).toBe('done');

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'completed' }],
    });

    // (2) The client actually fragmented the request as CEP-22 frames.
    const clientEvents = fixture.relayHub
      .getEvents()
      .filter((event) => event.pubkey === fixture.clientPubkey);
    const oversizedFrames = extractFrameTypes(
      clientEvents,
      'oversized-transfer',
    );
    expect(oversizedFrames[0]).toBe('start');
    expect(oversizedFrames.filter((t) => t === 'chunk').length).toBeGreaterThan(
      0,
    );
    expect(oversizedFrames[oversizedFrames.length - 1]).toBe('end');

    // (3) The server emitted the open-stream lifecycle over the wire.
    const serverEvents = fixture.relayHub
      .getEvents()
      .filter((event) => event.pubkey === fixture.serverPubkey);
    const openStreamFrames = extractFrameTypes(serverEvents, 'open-stream');
    expect(openStreamFrames).toContain('start');
    expect(openStreamFrames.filter((t) => t === 'chunk').length).toBe(2);
    expect(openStreamFrames[openStreamFrames.length - 1]).toBe('close');

    await cleanup(fixture);
  }, 15_000);
});
