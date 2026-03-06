import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
} from 'bun:test';
import { sleep } from 'bun';
import type { MockRelayInstance } from '../__mocks__/mock-relay-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { EncryptionMode } from '../core/interfaces.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

describe('NostrServerTransport Auth', () => {
  let relay: MockRelayInstance;
  let relayUrl: string;
  let httpUrl: string;

  beforeAll(async () => {
    const spawned = await spawnMockRelay();
    relay = spawned.relay;
    relayUrl = spawned.relayUrl;
    httpUrl = spawned.httpUrl;
  });

  afterEach(async () => {
    await clearRelayCache(httpUrl);
  });

  afterAll(async () => {
    relay.stop();
    await sleep(100);
  });

  // Helper function to create a client and its transport
  const createClientAndTransport = (
    privateKey: string,
    name: string,
    serverPublicKey: string,
  ) => {
    const client = new Client({ name, version: '1.0.0' });
    const clientNostrTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(privateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    return { client, clientNostrTransport };
  };

  test('should reject method calls from disallowed public keys', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPrivateKey = bytesToHex(generateSecretKey());
    const allowedClientPublicKey = getPublicKey(
      hexToBytes(allowedClientPrivateKey),
    );

    const disallowedClientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'Test Auth Server',
      version: '1.0.0',
    });

    // Add a dummy tool so listTools has something to return
    server.registerTool(
      'dummy',
      {
        title: 'Dummy Tool',
        description: 'A dummy tool',
        inputSchema: {},
      },
      async () => ({ content: [{ type: 'text', text: 'dummy' }] }),
    );

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey],
    });

    await server.connect(serverTransport);

    const {
      client: disallowedClient,
      clientNostrTransport: disallowedClientNostrTransport,
    } = createClientAndTransport(
      disallowedClientPrivateKey,
      'Disallowed Client',
      serverPublicKey,
    );

    // Connection should work because 'initialize' is always allowed
    const initializePromise = disallowedClient.connect(
      disallowedClientNostrTransport,
    );

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve('timeout'), 2000),
    );

    const result = await Promise.race([initializePromise, timeoutPromise]);

    expect(result).toBe('timeout');

    await disallowedClient.close();
    await server.close();
  }, 10000);
  test('should receive error from public server if unauthorized', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPrivateKey = bytesToHex(generateSecretKey());
    const allowedClientPublicKey = getPublicKey(
      hexToBytes(allowedClientPrivateKey),
    );

    const disallowedClientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'Test Public Auth Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey],
      isPublicServer: true,
    });

    await server.connect(serverTransport);

    const {
      client: disallowedClient,
      clientNostrTransport: disallowedClientNostrTransport,
    } = createClientAndTransport(
      disallowedClientPrivateKey,
      'Disallowed Client',
      serverPublicKey,
    );

    await expect(
      disallowedClient.connect(disallowedClientNostrTransport),
    ).rejects.toThrow('Unauthorized');

    await disallowedClient.close();
    await server.close();
  }, 10000);

  test('should create session for authorized client on first message', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPrivateKey = bytesToHex(generateSecretKey());
    const allowedClientPublicKey = getPublicKey(
      hexToBytes(allowedClientPrivateKey),
    );

    const unauthorizedClientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'Test Session Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey],
      isPublicServer: true, // Public server to send unauthorized error
    });

    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      allowedClientPrivateKey,
      'Allowed Client',
      serverPublicKey,
    );

    const {
      client: unauthorizedClient,
      clientNostrTransport: unauthorizedClientNostrTransport,
    } = createClientAndTransport(
      unauthorizedClientPrivateKey,
      'Unauthorized Client',
      serverPublicKey,
    );

    // Connect client (sends initialize message)
    await client.connect(clientNostrTransport);
    // Attempt to connect (should fail with Unauthorized error)
    await expect(
      unauthorizedClient.connect(unauthorizedClientNostrTransport),
    ).rejects.toThrow('Unauthorized');

    // Wait for session to be created
    await sleep(200);

    // Verify session exists for the authorized client
    const internalState = serverTransport.getInternalStateForTesting();
    const session = internalState.sessionStore.getSession(
      allowedClientPublicKey,
    );

    expect(session).toBeDefined();
    expect(session!.isInitialized).toBe(true);
    expect(session!.isEncrypted).toBe(false); // Encryption is disabled in createClientAndTransport
    expect(internalState.sessionStore.sessionCount).toBe(1);
    await client.close();
    await server.close();
  }, 10000);

  test('should require both static and dynamic pubkey authorization when both are configured', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPrivateKey = bytesToHex(generateSecretKey());
    const allowedClientPublicKey = getPublicKey(
      hexToBytes(allowedClientPrivateKey),
    );

    const server = new McpServer({
      name: 'Test Combined Auth Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey],
      isPubkeyAllowed: async () => false,
      isPublicServer: true,
    });

    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      allowedClientPrivateKey,
      'Allowed But Dynamically Rejected Client',
      serverPublicKey,
    );

    await expect(client.connect(clientNostrTransport)).rejects.toThrow(
      'Unauthorized',
    );

    await client.close();
    await server.close();
  }, 10000);

  test('should allow a client when dynamic pubkey authorization approves it without a static allowlist', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPrivateKey = bytesToHex(generateSecretKey());
    const allowedClientPublicKey = getPublicKey(
      hexToBytes(allowedClientPrivateKey),
    );

    const server = new McpServer({
      name: 'Test Dynamic Auth Server',
      version: '1.0.0',
    });

    server.registerTool(
      'dummy',
      {
        title: 'Dummy Tool',
        description: 'A dummy tool',
        inputSchema: {},
      },
      async () => ({ content: [{ type: 'text', text: 'dummy' }] }),
    );

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      isPubkeyAllowed: async (clientPubkey) =>
        clientPubkey === allowedClientPublicKey,
      isPublicServer: true,
    });

    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      allowedClientPrivateKey,
      'Dynamically Allowed Client',
      serverPublicKey,
    );

    await client.connect(clientNostrTransport);
    const tools = await client.listTools();

    expect(tools.tools.some((tool) => tool.name === 'dummy')).toBe(true);

    await client.close();
    await server.close();
  }, 10000);

  test('should allow capability exclusion when dynamic exclusion callback matches', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const disallowedClientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'Test Dynamic Capability Exclusion Server',
      version: '1.0.0',
    });

    server.registerTool(
      'dummy',
      {
        title: 'Dummy Tool',
        description: 'A dummy tool',
        inputSchema: {},
      },
      async () => ({ content: [{ type: 'text', text: 'dummy' }] }),
    );

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      allowedPublicKeys: [
        getPublicKey(hexToBytes(bytesToHex(generateSecretKey()))),
      ],
      isCapabilityExcluded: async (exclusion) =>
        exclusion.method === 'tools/list',
    });

    await server.connect(serverTransport);

    const {
      client: disallowedClient,
      clientNostrTransport: disallowedClientNostrTransport,
    } = createClientAndTransport(
      disallowedClientPrivateKey,
      'Disallowed Client With Dynamic Capability Exclusion',
      serverPublicKey,
    );

    await disallowedClient.connect(disallowedClientNostrTransport);
    const tools = await disallowedClient.listTools();

    expect(tools.tools.some((tool) => tool.name === 'dummy')).toBe(true);

    await disallowedClient.close();
    await server.close();
  }, 10000);
});
