import { expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import {
  ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@contextvm/mcp-sdk/types.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { sleep } from '../core/utils/utils.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { spawnMockRelay } from '../__mocks__/test-relay-helpers.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';

test('routes resources/updated only to clients subscribed to that resource', async () => {
  const relay = await spawnMockRelay();
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
  const alphaPrivateKey = bytesToHex(generateSecretKey());
  const betaPrivateKey = bytesToHex(generateSecretKey());

  const server = new McpServer(
    { name: 'Resource update server', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true } } },
  );
  server.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

  const serverTransport = new NostrServerTransport({
    signer: new PrivateKeySigner(serverPrivateKey),
    relayHandler: new ApplesauceRelayPool([relay.relayUrl]),
  });
  const alphaClient = new Client({ name: 'Alpha client', version: '1.0.0' });
  const betaClient = new Client({ name: 'Beta client', version: '1.0.0' });
  const alphaUpdates: string[] = [];
  const betaUpdates: string[] = [];

  alphaClient.setNotificationHandler(
    ResourceUpdatedNotificationSchema,
    (notification) => {
      alphaUpdates.push(notification.params.uri);
    },
  );
  betaClient.setNotificationHandler(
    ResourceUpdatedNotificationSchema,
    (notification) => {
      betaUpdates.push(notification.params.uri);
    },
  );

  try {
    await server.connect(serverTransport);
    await alphaClient.connect(
      new NostrClientTransport({
        signer: new PrivateKeySigner(alphaPrivateKey),
        relayHandler: new ApplesauceRelayPool([relay.relayUrl]),
        serverPubkey: serverPublicKey,
      }),
    );
    await betaClient.connect(
      new NostrClientTransport({
        signer: new PrivateKeySigner(betaPrivateKey),
        relayHandler: new ApplesauceRelayPool([relay.relayUrl]),
        serverPubkey: serverPublicKey,
      }),
    );

    await alphaClient.subscribeResource({ uri: 'resource://alpha' });
    await betaClient.subscribeResource({ uri: 'resource://beta' });

    await server.server.sendResourceUpdated({ uri: 'resource://alpha' });
    await sleep(150);

    expect(alphaUpdates).toEqual(['resource://alpha']);
    expect(betaUpdates).toEqual([]);

    await alphaClient.unsubscribeResource({ uri: 'resource://alpha' });
    await server.server.sendResourceUpdated({ uri: 'resource://alpha' });
    await sleep(150);

    expect(alphaUpdates).toEqual(['resource://alpha']);
    expect(betaUpdates).toEqual([]);
  } finally {
    await alphaClient.close().catch(() => undefined);
    await betaClient.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    relay.stop();
  }
});
