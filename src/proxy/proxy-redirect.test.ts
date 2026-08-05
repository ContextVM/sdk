import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { InMemoryTransport } from '@contextvm/mcp-sdk/inMemory';
import { z } from 'zod';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrServerTransport } from '../transport/nostr-server-transport.js';
import { NostrMCPProxy } from './index.js';
import { withServerRedirect } from '../redirect/index.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

describe.serial('NostrMCPProxy redirect wiring', () => {
  let relayUrl: string;
  let httpUrl: string;
  let stopRelay: (() => void) | undefined;

  beforeAll(async () => {
    const relay = await spawnMockRelay();
    relayUrl = relay.relayUrl;
    httpUrl = relay.httpUrl;
    stopRelay = relay.stop;
  });

  afterEach(async () => {
    await clearRelayCache(httpUrl);
  });

  afterAll(async () => {
    stopRelay?.();
    await sleep(100);
  });

  test('proxy correctly follows a server redirect', async () => {
    // Target Server
    const targetSK = generateSecretKey();
    const targetServer = new McpServer({
      name: 'proxy-target-server',
      version: '1.0.0',
    });
    targetServer.registerTool(
      'echo',
      {
        title: 'Echo',
        description: 'Echoes the message',
        inputSchema: { message: z.string() },
      },
      async ({ message }: { message: string }) => ({
        content: [{ type: 'text', text: `Redirected: ${message}` }],
      }),
    );
    const targetTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(bytesToHex(targetSK)),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
    });
    await targetServer.connect(targetTransport);
    const targetPubkey = getPublicKey(targetSK);

    // Initial Server (redirects to Target Server)
    const initialSK = generateSecretKey();
    const initialServer = new McpServer({
      name: 'proxy-initial-server',
      version: '1.0.0',
    });
    // It doesn't even need the tool registered because the middleware intercepts it
    const initialTransport = withServerRedirect(
      new NostrServerTransport({
        signer: new PrivateKeySigner(bytesToHex(initialSK)),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        resolveRedirect: async () => ({ target: targetPubkey, relays: [relayUrl] }),
      }
    );
    await initialServer.connect(initialTransport);
    const initialPubkey = getPublicKey(initialSK);

    // Host side of an in-memory pair; the proxy relays MCP through it.
    const [hostTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const proxy = new NostrMCPProxy({
      mcpHostTransport: hostTransport,
      nostrTransportOptions: {
        signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverPubkey: initialPubkey,
        encryptionMode: EncryptionMode.DISABLED,
      },
      redirectOptions: { maxRedirects: 2 },
    });
    await proxy.start();

    const client = new Client({ name: 'proxy-host-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const res = await client.callTool({ name: 'echo', arguments: { message: 'hello proxy' } });
    expect((res.content as Array<{ text: string }>)[0].text).toBe('Redirected: hello proxy');

    await client.close();
    await proxy.stop();
    await targetServer.close();
    await initialServer.close();
  }, 20000);
});
