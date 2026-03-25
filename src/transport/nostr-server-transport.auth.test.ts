import { afterAll, describe, test, expect } from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EncryptionMode } from '../core/interfaces.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';

describe.serial('NostrServerTransport Auth', () => {
  afterAll(async () => {
    await sleep(100);
  });

  // Helper function to create a client and its transport
  const createClientAndTransport = (
    relayHub: MockRelayHub,
    privateKey: string,
    name: string,
    serverPublicKey: string,
  ): {
    client: Client;
    clientNostrTransport: NostrClientTransport;
  } => {
    const client = new Client({ name, version: '1.0.0' });
    const clientNostrTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(privateKey),
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    return { client, clientNostrTransport };
  };

  test('should reject method calls from disallowed public keys', async () => {
    const relayHub = new MockRelayHub();
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
      relayHandler: relayHub.createRelayHandler(),
      allowedPublicKeys: [allowedClientPublicKey],
    });

    await server.connect(serverTransport);

    const {
      client: disallowedClient,
      clientNostrTransport: disallowedClientNostrTransport,
    } = createClientAndTransport(
      relayHub,
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
    await initializePromise.catch(() => undefined);
    await server.close();
    relayHub.clear();
  }, 10000);
  test('should receive error from public server if unauthorized', async () => {
    const relayHub = new MockRelayHub();
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
      relayHandler: relayHub.createRelayHandler(),
      allowedPublicKeys: [allowedClientPublicKey],
      isPublicServer: true,
    });

    await server.connect(serverTransport);

    const {
      client: disallowedClient,
      clientNostrTransport: disallowedClientNostrTransport,
    } = createClientAndTransport(
      relayHub,
      disallowedClientPrivateKey,
      'Disallowed Client',
      serverPublicKey,
    );

    await expect(
      disallowedClient.connect(disallowedClientNostrTransport),
    ).rejects.toThrow('Unauthorized');

    await disallowedClient.close();
    await server.close();
    relayHub.clear();
  }, 10000);

  test('should create session for authorized client on first message', async () => {
    const relayHub = new MockRelayHub();
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
      relayHandler: relayHub.createRelayHandler(),
      allowedPublicKeys: [allowedClientPublicKey],
      isPublicServer: true, // Public server to send unauthorized error
    });

    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      relayHub,
      allowedClientPrivateKey,
      'Allowed Client',
      serverPublicKey,
    );

    const {
      client: unauthorizedClient,
      clientNostrTransport: unauthorizedClientNostrTransport,
    } = createClientAndTransport(
      relayHub,
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
    await unauthorizedClient.close();
    await server.close();
    relayHub.clear();
  }, 10000);
});
