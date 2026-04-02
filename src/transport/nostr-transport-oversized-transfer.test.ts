import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { z } from 'zod';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';

describe.serial('Nostr transport oversized transfer', () => {
  test('round-trips oversized request and oversized response with progress framing', async () => {
    const relayHub = new MockRelayHub();
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const server = new McpServer({
      name: 'Oversized Server',
      version: '1.0.0',
    });

    server.registerTool(
      'roundtrip_large',
      {
        title: 'Roundtrip Large',
        description: 'Echoes a large payload back to the client',
        inputSchema: {
          payload: z.string(),
        },
      },
      async ({ payload }) => ({
        content: [{ type: 'text', text: payload }],
      }),
    );

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      encryptionMode: EncryptionMode.DISABLED,
      oversizedTransfer: {
        enabled: true,
        thresholdBytes: 256,
        chunkSizeBytes: 96,
      },
    });

    await server.connect(serverTransport);

    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
      oversizedTransfer: {
        enabled: true,
        thresholdBytes: 256,
        chunkSizeBytes: 96,
      },
    });

    const client = new Client({
      name: 'Oversized Client',
      version: '1.0.0',
    });

    await client.connect(clientTransport);

    const payload = 'x'.repeat(8_000);
    const result = await client.callTool(
      {
        name: 'roundtrip_large',
        arguments: {
          payload,
        },
      },
      undefined,
      {
        onprogress: () => undefined,
        resetTimeoutOnProgress: true,
      },
    );

    const typedResult = result as {
      content: Array<{ type: string; text?: string }>;
    };

    expect(typedResult.content[0]).toMatchObject({
      type: 'text',
      text: payload,
    });

    await client.close();
    await server.close();
    relayHub.clear();
  }, 30000);
});
