import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
} from 'bun:test';
import { sleep, type Subprocess } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { SimpleRelayPool } from '../relay/simple-relay-pool.js';
import { generateSecretKey, getPublicKey, NostrEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { TEST_PRIVATE_KEY } from '../__mocks__/fixtures.js';
import { SERVER_ANNOUNCEMENT_KIND } from '../core/constants.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EncryptionMode } from '../core/interfaces.js';

const baseRelayPort = 7790; // Use a different port to avoid conflicts
const relayUrl = `ws://localhost:${baseRelayPort}`;

describe('NostrServerTransport', () => {
  let relayProcess: Subprocess;

  beforeAll(async () => {
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${baseRelayPort}`,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await sleep(100);
  });

  afterEach(async () => {
    if (relayUrl) {
      try {
        const clearUrl = relayUrl.replace('ws://', 'http://') + '/clear-cache';
        await fetch(clearUrl, { method: 'POST' });
        console.log('[TEST] Event cache cleared');
      } catch (error) {
        console.warn('[TEST] Failed to clear event cache:', error);
      }
    }
  });

  afterAll(async () => {
    relayProcess?.kill();
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
      relayHandler: new SimpleRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
    });
    return { client, clientNostrTransport };
  };

  test('should publish a server announcement event when isPublicServer is true', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    // Create a mock MCP server
    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new SimpleRelayPool([relayUrl]),
      serverInfo: {
        name: 'Test Server',
        website: 'http://localhost',
      },
      isPublicServer: true,
    });

    await server.connect(transport);

    let announcementEvent: NostrEvent | null = null;
    const relayPool = new SimpleRelayPool([relayUrl]);
    await relayPool.connect();

    await relayPool.subscribe(
      [{ kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] }],
      (event) => {
        announcementEvent = event;
      },
    );

    await sleep(100);

    expect(announcementEvent).toBeDefined();
    expect(announcementEvent!.kind).toBe(SERVER_ANNOUNCEMENT_KIND);
    expect(announcementEvent!.pubkey).toBe(serverPublicKey);
    expect(JSON.parse(announcementEvent!.content).serverInfo.name).toBe(
      'Test Server',
    );
    expect(
      JSON.parse(announcementEvent!.content).protocolVersion,
    ).toBeDefined();

    await server.close();
    await relayPool.disconnect();
  }, 5000);

  test('should allow connection for allowed public keys', async () => {
    const serverPrivateKey = TEST_PRIVATE_KEY;
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPrivateKey = bytesToHex(generateSecretKey());
    const allowedClientPublicKey = getPublicKey(
      hexToBytes(allowedClientPrivateKey),
    );

    const server = new McpServer({
      name: 'Allowed Server',
      version: '1.0.0',
    });
    const allowedTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new SimpleRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey],
      serverInfo: {
        name: 'Allowed Server',
        website: 'https://model-context.org',
        picture:
          'https://www.contextvm.org/_astro/contextvm-logo.CHHzLZGt_A0IIg.svg',
      },
    });

    await server.connect(allowedTransport);

    const {
      client: allowedClient,
      clientNostrTransport: allowedClientNostrTransport,
    } = createClientAndTransport(
      allowedClientPrivateKey,
      'Allowed Client',
      serverPublicKey,
    );

    expect(
      allowedClient.connect(allowedClientNostrTransport),
    ).resolves.toBeUndefined();
    await allowedClient.close();
    await server.close();
  }, 10000);

  test('should not allow connection for disallowed public keys and timeout', async () => {
    const serverPrivateKey = TEST_PRIVATE_KEY;
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPublicKey = getPublicKey(
      hexToBytes(bytesToHex(generateSecretKey())), // Generate a dummy key for the allowed list
    );
    const disallowedClientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'Disallowed Server',
      version: '1.0.0',
    });

    const allowedTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new SimpleRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey], // Only allow the dummy key
    });

    await server.connect(allowedTransport);

    const {
      client: disallowedClient,
      clientNostrTransport: disallowedClientNostrTransport,
    } = createClientAndTransport(
      disallowedClientPrivateKey,
      'Disallowed Client',
      serverPublicKey,
    );

    const timeoutPromise = new Promise<string>((resolve) => {
      sleep(1000).then(() => {
        resolve('timeout');
      });
    });

    const connectPromise = disallowedClient
      .connect(disallowedClientNostrTransport)
      .then(() => 'connected');

    const result = await Promise.race([connectPromise, timeoutPromise]);
    expect(result).toBe('timeout');
    await server.close();
  }, 10000);

  test('should include all server metadata tags in announcement events', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new SimpleRelayPool([relayUrl]),
      serverInfo: {
        name: 'Test Server',
        about: 'A test server for CTXVM',
        website: 'http://localhost',
        picture: 'http://localhost/logo.png',
      },
      isPublicServer: true,
    });

    await server.connect(transport);

    // Subscribe to announcement events
    let announcementEvent: NostrEvent | null = null;
    const relayPool = new SimpleRelayPool([relayUrl]);
    await relayPool.connect();

    await relayPool.subscribe(
      [{ kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] }],
      (event) => {
        announcementEvent = event;
      },
    );

    await sleep(100);

    expect(announcementEvent).toBeDefined();
    expect(announcementEvent!.tags).toBeDefined();
    expect(Array.isArray(announcementEvent!.tags)).toBe(true);

    // Convert tags to an object for easier testing
    const tagsObject: { [key: string]: string } = {};
    announcementEvent!.tags.forEach((tag: string[]) => {
      if (
        tag.length >= 2 &&
        typeof tag[0] === 'string' &&
        typeof tag[1] === 'string'
      ) {
        tagsObject[tag[0]] = tag[1];
      }
    });

    // Verify all server metadata tags are present
    expect(tagsObject.name).toBe('Test Server');
    expect(tagsObject.about).toBe('A test server for CTXVM');
    expect(tagsObject.website).toBe('http://localhost');
    expect(tagsObject.picture).toBe('http://localhost/logo.png');

    // Verify support_encryption tag is present
    const supportEncryptionTag = announcementEvent!.tags.find(
      (tag: string[]) => tag.length === 1 && tag[0] === 'support_encryption',
    );
    expect(supportEncryptionTag).toBeDefined();

    await server.close();
    await relayPool.disconnect();
  }, 5000);

  test('should include only name tag when serverInfo is minimal and encryption disabled', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const server = new McpServer({
      name: 'Minimal Server',
      version: '1.0.0',
    });

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new SimpleRelayPool([relayUrl]),
      serverInfo: {
        name: 'Minimal Server',
      },
      encryptionMode: EncryptionMode.DISABLED, // Disable encryption
      isPublicServer: true,
    });

    await server.connect(transport);

    // Subscribe to announcement events
    let announcementEvent: NostrEvent | null = null;
    const relayPool = new SimpleRelayPool([relayUrl]);
    await relayPool.connect();

    await relayPool.subscribe(
      [{ kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] }],
      (event) => {
        announcementEvent = event;
      },
    );

    await sleep(100);

    expect(announcementEvent).toBeDefined();
    expect(announcementEvent!.tags).toBeDefined();

    // Check that only the name tag is present
    const nameTags = announcementEvent!.tags.filter(
      (tag: string[]) => tag.length >= 2 && tag[0] === 'name',
    );
    expect(nameTags.length).toBe(1);
    expect(nameTags[0][1]).toBe('Minimal Server');

    // Check that no support_encryption tag is present
    const supportEncryptionTag = announcementEvent!.tags.find(
      (tag: string[]) => tag.length === 1 && tag[0] === 'support_encryption',
    );
    expect(supportEncryptionTag).toBeUndefined();

    await server.close();
    await relayPool.disconnect();
  }, 5000);

  test('should store server initialize event after receiving it', async () => {
    const serverPrivateKey = TEST_PRIVATE_KEY;
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const clientPrivateKey = bytesToHex(generateSecretKey());

    // Create a mock MCP server
    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new SimpleRelayPool([relayUrl]),
      serverInfo: {
        name: 'Test Server',
        website: 'http://localhost',
      },
      isPublicServer: true,
    });

    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      'Test Client',
      serverPublicKey,
    );

    // Connect the client
    await client.connect(clientNostrTransport);

    // Wait for the initialize event to be processed
    await sleep(200);

    // Check that the client transport has stored the initialize event
    const storedInitializeEvent =
      clientNostrTransport.getServerInitializeEvent();
    expect(storedInitializeEvent).toBeDefined();
    expect(storedInitializeEvent).not.toBeNull();
    expect(storedInitializeEvent!.pubkey).toBe(serverPublicKey);

    // Verify that the event content contains the expected result
    const content = JSON.parse(storedInitializeEvent!.content);
    expect(content.result).toBeDefined();
    expect(content.result).not.toBeNull();
    expect(content.result.protocolVersion).toBeDefined();
    expect(content.result.capabilities).toBeDefined();

    await client.close();
    await server.close();
  }, 10000);
});
