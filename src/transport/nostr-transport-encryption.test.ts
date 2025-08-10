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
import { generateSecretKey, getPublicKey, NostrEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EncryptionMode } from '../core/interfaces.js';
import { CTXVM_MESSAGES_KIND, GIFT_WRAP_KIND } from '../core/constants.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';

const baseRelayPort = 7791;
const relayUrl = `ws://localhost:${baseRelayPort}`;

describe('NostrTransport Encryption', () => {
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
      } catch (error) {
        console.log('Error clearing relay cache:', error);
      }
    }
  });

  afterAll(async () => {
    relayProcess?.kill();
    await sleep(100);
  });

  // Helper to create a client and its transport
  const createClientAndTransport = (
    privateKey: string,
    serverPublicKey: string,
    encryptionMode: EncryptionMode,
  ) => {
    const client = new Client({ name: 'TestClient', version: '1.0.0' });
    const clientNostrTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(privateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode,
    });
    return { client, clientNostrTransport };
  };

  // Helper to create a server and its transport
  const createServerAndTransport = (
    privateKey: string,
    encryptionMode: EncryptionMode,
  ) => {
    const server = new McpServer({ name: 'TestServer', version: '1.0.0' });
    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(privateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode,
      serverInfo: {},
    });
    return { server, serverTransport };
  };

  test('should connect successfully with OPTIONAL encryption on both ends', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.OPTIONAL,
    );
    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.OPTIONAL,
    );

    expect(client.connect(clientNostrTransport)).resolves.toBeUndefined();

    await client.close();
    await server.close();
  }, 5000);

  test('should connect with REQUIRED (client) and OPTIONAL (server)', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.OPTIONAL,
    );
    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.REQUIRED,
    );

    expect(client.connect(clientNostrTransport)).resolves.toBeUndefined();

    await client.close();
    await server.close();
  }, 5000);

  test('should connect with OPTIONAL (client) and REQUIRED (server)', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.REQUIRED,
    );
    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.OPTIONAL,
    );

    expect(client.connect(clientNostrTransport)).resolves.toBeUndefined();

    await client.close();
    await server.close();
  }, 5000);

  test('should connect with REQUIRED on both ends', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.REQUIRED,
    );
    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.REQUIRED,
    );

    expect(client.connect(clientNostrTransport)).resolves.toBeUndefined();

    await client.close();
    await server.close();
  }, 5000);

  test('should fail to connect if client requires encryption and server disables it', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.DISABLED,
    );
    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.REQUIRED,
    );

    const connectPromise = client.connect(clientNostrTransport);
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve('timeout'), 2000),
    );

    expect(Promise.race([connectPromise, timeoutPromise])).resolves.toBe(
      'timeout',
    );

    await client.close();
    await server.close();
  }, 5000);

  test('should connect successfully if both client and server have encryption disabled', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.DISABLED,
    );
    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.DISABLED,
    );

    expect(client.connect(clientNostrTransport)).resolves.toBeUndefined();

    await client.close();
    await server.close();
  }, 5000);

  test('should fail to connect if client encryption is disabled and server requires it', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.REQUIRED, // Server requires encryption
    );
    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.DISABLED, // Client encryption is disabled
    );

    // The client should not be able to connect because the server requires encryption
    // but the client is trying to connect without encryption.
    const connectPromise = client.connect(clientNostrTransport);
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve('timeout'), 2000),
    );

    expect(Promise.race([connectPromise, timeoutPromise])).resolves.toBe(
      'timeout',
    );

    await client.close();
    await server.close();
  }, 5000);

  test('should mirror the format of the request in EncryptionMode.OPTIONAL: client encryption is disabled', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const collectedEvents: NostrEvent[] = [];
    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.OPTIONAL,
    );
    await server.connect(serverTransport);
    await Bun.sleep(100);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.DISABLED,
    );

    const relayHandler = new ApplesauceRelayPool([relayUrl]);
    relayHandler.subscribe([{ kinds: [CTXVM_MESSAGES_KIND] }], (event) => {
      collectedEvents.push(event);
    });
    await client.connect(clientNostrTransport);
    expect(collectedEvents.length).toBeGreaterThan(0);

    await client.close();
    await server.close();
  }, 5000);

  test('should mirror the format of the request in EncryptionMode.OPTIONAL: client encryption is required', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const collectedEvents: NostrEvent[] = [];
    const { server, serverTransport } = createServerAndTransport(
      serverPrivateKey,
      EncryptionMode.OPTIONAL,
    );
    await server.connect(serverTransport);
    await Bun.sleep(100);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      serverPublicKey,
      EncryptionMode.REQUIRED,
    );

    const relayHandler = new ApplesauceRelayPool([relayUrl]);
    relayHandler.subscribe([{ kinds: [GIFT_WRAP_KIND] }], (event) => {
      collectedEvents.push(event);
    });
    await client.connect(clientNostrTransport);
    expect(collectedEvents.length).toBeGreaterThan(0);

    await client.close();
    await server.close();
  }, 10000);
});
