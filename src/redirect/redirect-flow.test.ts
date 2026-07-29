import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { z } from 'zod';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { Client } from '@contextvm/mcp-sdk/client';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';

import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrServerTransport } from '../transport/nostr-server-transport.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { withServerRedirect } from './server-transport-redirect.js';
import { withClientRedirect } from './client-redirect.js';
import { REDIRECT_ERROR_CODE } from '../payments/constants.js';

describe.serial('Redirect Flow E2E', () => {
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

  afterAll(() => {
    stopRelay?.();
  });

  const createServer = async (
    pubkeySK: Uint8Array,
    redirectTarget?: string,
  ) => {
    const server = new McpServer({
      name: 'test-server',
      version: '1.0.0',
    });
    server.registerTool(
      'echo',
      {
        title: 'Echo',
        description: 'Echoes message',
        inputSchema: { message: z.string() },
      },
      async ({ message }: { message: string }) => ({
        content: [{ type: 'text', text: message }],
      }),
    );

    let transport = new NostrServerTransport({
      signer: new PrivateKeySigner(bytesToHex(pubkeySK)),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
    });

    if (redirectTarget) {
      transport = withServerRedirect(transport, {
        resolveRedirect: () => ({ target: redirectTarget, relays: [relayUrl] }),
      });
    }

    await server.connect(transport);
    return { server, transport };
  };

  test('End-to-end single redirect: Client -> Server A (redirects) -> Server B (responds)', async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const pkB = getPublicKey(skB);

    const { transport: transportA } = await createServer(skA, pkB);
    const { transport: transportB } = await createServer(skB);

    const clientSK = generateSecretKey();
    const baseOpts = {
      signer: new PrivateKeySigner(bytesToHex(clientSK)),
      encryptionMode: EncryptionMode.DISABLED,
      isStateless: false,
    };

    const baseTransport = new NostrClientTransport({
      ...baseOpts,
      serverPubkey: getPublicKey(skA),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
    });

    const clientTransport = withClientRedirect(
      baseTransport,
      { ...baseOpts, wrapTransport: (t) => t },
      { maxRedirects: 3 },
    );

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'hello redirect' },
    });

    expect(result.content).toBeArray();
    expect((result.content as any[])?.[0]).toEqual({ type: 'text', text: 'hello redirect' });

    // Verify current transport server is now pkB
    const activeTransport = clientTransport as unknown as NostrClientTransport;
    expect(activeTransport.serverPubkey).toBe(pkB);

    await client.close();
    await transportA.close();
    await transportB.close();
  });

  test('Chained redirect: Client -> Server A -> Server B -> Server C (responds)', async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const skC = generateSecretKey();
    
    const pkB = getPublicKey(skB);
    const pkC = getPublicKey(skC);

    const { transport: transportA } = await createServer(skA, pkB);
    const { transport: transportB } = await createServer(skB, pkC);
    const { transport: transportC } = await createServer(skC);

    const clientSK = generateSecretKey();
    const baseOpts = {
      signer: new PrivateKeySigner(bytesToHex(clientSK)),
      encryptionMode: EncryptionMode.DISABLED,
    };

    const baseTransport = new NostrClientTransport({
      ...baseOpts,
      serverPubkey: getPublicKey(skA),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
    });

    const clientTransport = withClientRedirect(baseTransport, baseOpts);

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'chain test' },
    });

    expect((result.content as any[])?.[0]).toEqual({ type: 'text', text: 'chain test' });
    expect((clientTransport as unknown as NostrClientTransport).serverPubkey).toBe(pkC);

    await client.close();
    await transportA.close();
    await transportB.close();
    await transportC.close();
  });

  test('Loop detection: Client -> Server A -> Server B -> Server A -> (hops out) -> Error', async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const pkA = getPublicKey(skA);
    const pkB = getPublicKey(skB);

    const { transport: transportA } = await createServer(skA, pkB);
    const { transport: transportB } = await createServer(skB, pkA);

    const clientSK = generateSecretKey();
    const baseOpts = {
      signer: new PrivateKeySigner(bytesToHex(clientSK)),
      encryptionMode: EncryptionMode.DISABLED,
    };

    const baseTransport = new NostrClientTransport({
      ...baseOpts,
      serverPubkey: pkA,
      relayHandler: new ApplesauceRelayPool([relayUrl]),
    });

    // Set a small hop cap
    const clientTransport = withClientRedirect(baseTransport, baseOpts, { maxRedirects: 2 });

    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    // It should hit max redirects on the initialize request and return the -32044 error
    await expect(client.connect(clientTransport)).rejects.toMatchObject({
      code: REDIRECT_ERROR_CODE,
    });

    await transportA.close();
    await transportB.close();
  });
});
