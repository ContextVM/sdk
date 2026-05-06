import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

function getOpenStreamWriter(extra: {
  _meta?: Record<string, unknown>;
}): OpenStreamWriter {
  const stream = (extra._meta as { stream?: OpenStreamWriter } | undefined)
    ?.stream;

  expect(stream).toBeDefined();

  return stream as OpenStreamWriter;
}

describe('callToolStream end-to-end', () => {
  test('streams tool output over CEP-41 with an ergonomic client API', async () => {
    const relayHub = new MockRelayHub();
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'stream-server',
      version: '1.0.0',
    });

    server.registerTool(
      'subscribeToEvents',
      {
        title: 'Subscribe To Events',
        description: 'Streams mock event notifications to the caller.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`event:1:${topic}`);
        await stream.write(`event:2:${topic}`);
        await stream.close();

        return {
          content: [{ type: 'text', text: `completed:${topic}` }],
          structuredContent: {
            topic,
            streamed: true,
          },
        };
      },
    );

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      encryptionMode: EncryptionMode.DISABLED,
      openStream: {
        enabled: true,
      },
    });

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
      openStream: {
        enabled: true,
      },
    });

    const client = new Client({
      name: 'stream-client',
      version: '1.0.0',
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'subscribeToEvents',
      arguments: {
        topic: 'orders',
      },
    });

    const chunksPromise = (async (): Promise<string[]> => {
      const chunks: string[] = [];

      for await (const chunk of call.stream) {
        chunks.push(chunk.value);
      }

      return chunks;
    })();

    const [chunks, result] = await Promise.all([chunksPromise, call.result]);

    expect(chunks).toEqual(['event:1:orders', 'event:2:orders']);
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'completed:orders' }],
      structuredContent: {
        topic: 'orders',
        streamed: true,
      },
    });

    await client.close();
    await server.close();
    relayHub.clear();
  }, 15_000);
});
