import { describe, expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { z } from 'zod';
import { EncryptionMode } from '../core/interfaces.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import type { OpenStreamWriter } from './open-stream/index.js';
import { callToolStream } from './call-tool-stream.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';

interface Fixture {
  relayHub: MockRelayHub;
  server: McpServer;
  client: Client;
  serverTransport: NostrServerTransport;
  clientTransport: NostrClientTransport;
}

function createFixture(): Fixture {
  const relayHub = new MockRelayHub();
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
  const clientPrivateKey = bytesToHex(generateSecretKey());

  const server = new McpServer({ name: 'conflict-server', version: '1.0.0' });

  const serverTransport = new NostrServerTransport({
    signer: new PrivateKeySigner(serverPrivateKey),
    relayHandler: relayHub.createRelayHandler(),
    encryptionMode: EncryptionMode.DISABLED,
    openStream: { enabled: true },
  });

  const clientTransport = new NostrClientTransport({
    signer: new PrivateKeySigner(clientPrivateKey),
    relayHandler: relayHub.createRelayHandler(),
    serverPubkey: serverPublicKey,
    encryptionMode: EncryptionMode.DISABLED,
    openStream: { enabled: true },
  });

  const client = new Client({ name: 'conflict-client', version: '1.0.0' });

  return { relayHub, server, client, serverTransport, clientTransport };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fixture.client.close();
  await fixture.server.close();
  fixture.relayHub.clear();
}

describe('open-stream progress-token conflict (issue)', () => {
  test('a plain callTool with onprogress returns and does not break a live stream', async () => {
    // Reproduces docs/ISSUE-open-stream-progress-token-conflict.md:
    // - A long-lived streaming subscription is active.
    // - A plain (non-streaming) callTool uses standard MCP progress options
    //   (`onprogress` + `resetTimeoutOnProgress`), which injects a progress token.
    // Expected: the plain call returns its result and the subscription keeps
    //   delivering. Before the fix the plain call hung (server deferred its
    //   response forever) and the stream was silently mis-bound.
    const fixture = createFixture();
    let releaseStream: (() => void) | undefined;

    fixture.server.registerTool(
      'subscribe',
      {
        title: 'Subscribe',
        description: 'Streams two values across a release latch.',
        inputSchema: { topic: z.string() },
      },
      async ({ topic }, extra) => {
        const stream = (extra?._meta as { stream?: OpenStreamWriter } | undefined)
          ?.stream;
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

        return {
          content: [{ type: 'text', text: `done:${topic}` }],
        };
      },
    );

    fixture.server.registerTool(
      'ping',
      {
        title: 'Ping',
        description: 'Plain request/response tool (no streaming).',
        inputSchema: {},
      },
      async () => ({
        content: [{ type: 'text', text: 'pong' }],
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

    // (2) Issue a plain RPC with the standard MCP progress options. This used
    //     to hang until the 60s timeout because the server created (but never
    //     used) an open-stream writer for the token and deferred the response.
    const progressTicks: number[] = [];
    const pingResult = await fixture.client.callTool(
      { name: 'ping', arguments: {} },
      undefined,
      {
        onprogress: (progress: unknown) => {
          progressTicks.push(Number(progress));
        },
        resetTimeoutOnProgress: true,
      },
    );

    expect(pingResult).toMatchObject({
      content: [{ type: 'text', text: 'pong' }],
    });

    // (3) The subscription must still deliver after the plain call completes.
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

  test('a plain callTool with onprogress returns even with no active stream', async () => {
    // Guards the server-side fix in isolation: the token-bearing request must
    // not be deferred when no streaming is happening at all.
    const fixture = createFixture();

    fixture.server.registerTool(
      'ping',
      {
        title: 'Ping',
        description: 'Plain request/response tool (no streaming).',
        inputSchema: {},
      },
      async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }),
    );

    await fixture.server.connect(fixture.serverTransport);
    await fixture.client.connect(fixture.clientTransport);

    const result = await fixture.client.callTool(
      { name: 'ping', arguments: {} },
      undefined,
      {
        onprogress: () => undefined,
        resetTimeoutOnProgress: true,
      },
    );

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'pong' }],
    });

    await cleanup(fixture);
  }, 15_000);
});
