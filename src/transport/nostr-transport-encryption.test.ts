import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  test,
  expect,
} from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';
import {
  CTXVM_MESSAGES_KIND,
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
} from '../core/constants.js';
import type { RelayHandler } from '../core/interfaces.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { waitFor } from '../core/utils/test.utils.js';

describe.serial('NostrTransport Encryption', () => {
  let relayHub: MockRelayHub;

  beforeAll(async () => {
    relayHub = new MockRelayHub();
  });

  afterEach(async () => {
    relayHub.clear();
  });

  afterAll(async () => {
    relayHub.clear();
  });

  // Helper to create a client and its transport
  const createClientAndTransport = (
    privateKey: string,
    serverPublicKey: string,
    encryptionMode: EncryptionMode,
    giftWrapMode?: GiftWrapMode,
    isStateless?: boolean,
    clientRelayHandler?: RelayHandler,
  ) => {
    const client = new Client({ name: 'TestClient', version: '1.0.0' });
    const clientNostrTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(privateKey),
      relayHandler: clientRelayHandler ?? relayHub.createRelayHandler(),
      serverPubkey: serverPublicKey,
      encryptionMode,
      giftWrapMode,
      isStateless,
    });
    return { client, clientNostrTransport };
  };

  // Helper to create a server and its transport
  const createServerAndTransport = (
    privateKey: string,
    encryptionMode: EncryptionMode,
    giftWrapMode?: GiftWrapMode,
    serverRelayHandler?: RelayHandler,
  ) => {
    const server = new McpServer({ name: 'TestServer', version: '1.0.0' });
    // Ensure the default MCP server has at least one capability so listTools succeeds.
    server.registerTool(
      'noop',
      {
        title: 'noop',
        description: 'noop',
      },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(privateKey),
      relayHandler: serverRelayHandler ?? relayHub.createRelayHandler(),
      encryptionMode,
      giftWrapMode,
      serverInfo: {},
    });
    return { server, serverTransport };
  };

  test.serial(
    'should connect successfully with OPTIONAL encryption on both ends',
    async () => {
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
    },
    5000,
  );

  test.serial(
    'should connect with REQUIRED (client) and OPTIONAL (server)',
    async () => {
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

      await expect(
        client.connect(clientNostrTransport),
      ).resolves.toBeUndefined();

      await client.close();
      await server.close();
    },
    5000,
  );

  test.serial(
    'should connect with OPTIONAL (client) and REQUIRED (server)',
    async () => {
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

      await expect(
        client.connect(clientNostrTransport),
      ).resolves.toBeUndefined();

      await client.close();
      await server.close();
    },
    5000,
  );

  test.serial(
    'should connect with REQUIRED on both ends',
    async () => {
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

      await expect(
        client.connect(clientNostrTransport),
      ).resolves.toBeUndefined();

      await client.close();
      await server.close();
    },
    5000,
  );

  test.serial(
    'should fail to connect if client requires encryption and server disables it',
    async () => {
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

      await expect(
        Promise.race([connectPromise, timeoutPromise]),
      ).resolves.toBe('timeout');

      await client.close();
      await connectPromise.catch(() => undefined);
      await server.close();
    },
    5000,
  );

  test.serial(
    'should connect successfully if both client and server have encryption disabled',
    async () => {
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

      await expect(
        client.connect(clientNostrTransport),
      ).resolves.toBeUndefined();

      await client.close();
      await server.close();
    },
    5000,
  );

  test.serial(
    'should fail to connect if client encryption is disabled and server requires it',
    async () => {
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

      await expect(
        Promise.race([connectPromise, timeoutPromise]),
      ).resolves.toBe('timeout');

      await client.close();
      await connectPromise.catch(() => undefined);
      await server.close();
    },
    5000,
  );

  test.serial(
    'should mirror the format of the request in EncryptionMode.OPTIONAL: client encryption is disabled',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const collectedEvents: NostrEvent[] = [];
      const { server, serverTransport } = createServerAndTransport(
        serverPrivateKey,
        EncryptionMode.OPTIONAL,
      );
      await server.connect(serverTransport);

      const { client, clientNostrTransport } = createClientAndTransport(
        clientPrivateKey,
        serverPublicKey,
        EncryptionMode.DISABLED,
      );

      const relayHandler = relayHub.createRelayHandler();
      relayHandler.subscribe([{ kinds: [CTXVM_MESSAGES_KIND] }], (event) => {
        collectedEvents.push(event);
      });
      await client.connect(clientNostrTransport);
      await waitFor({
        produce: () =>
          collectedEvents.length > 0 ? collectedEvents : undefined,
      });
      expect(collectedEvents.length).toBeGreaterThan(0);

      await client.close();
      await server.close();
    },
    5000,
  );

  test.serial(
    'should mirror the format of the request in EncryptionMode.OPTIONAL: client encryption is required',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const collectedEvents: NostrEvent[] = [];
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

      const relayHandler = relayHub.createRelayHandler();
      relayHandler.subscribe([{ kinds: [GIFT_WRAP_KIND] }], (event) => {
        collectedEvents.push(event);
      });
      await client.connect(clientNostrTransport);
      await waitFor({
        produce: () =>
          collectedEvents.length > 0 ? collectedEvents : undefined,
      });
      expect(collectedEvents.length).toBeGreaterThan(0);

      await client.close();
      await server.close();
    },
    10000,
  );

  test.serial(
    'client optional should use kind 21059 when server advertises support_encryption_ephemeral',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const collectedEvents: NostrEvent[] = [];

      const { server, serverTransport } = createServerAndTransport(
        serverPrivateKey,
        EncryptionMode.OPTIONAL,
        GiftWrapMode.EPHEMERAL,
      );
      await server.connect(serverTransport);

      const { client, clientNostrTransport } = createClientAndTransport(
        clientPrivateKey,
        serverPublicKey,
        EncryptionMode.REQUIRED,
        GiftWrapMode.EPHEMERAL,
      );

      const relayHandler = relayHub.createRelayHandler();
      relayHandler.subscribe(
        [{ kinds: [EPHEMERAL_GIFT_WRAP_KIND] }],
        (event) => {
          collectedEvents.push(event);
        },
      );

      await client.connect(clientNostrTransport);

      await client.listTools();

      await waitFor({
        produce: () =>
          collectedEvents.length > 0 ? collectedEvents : undefined,
      });
      expect(collectedEvents.length).toBeGreaterThan(0);

      await client.close();
      await server.close();
    },
    10000,
  );

  test.serial(
    'stateless client optional should switch to kind 21059 after first server response advertises support_encryption_ephemeral',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());

      const giftWrapKindsObserved: number[] = [];

      const serverRelayHandler = relayHub.createRelayHandler();
      const clientRelayHandler = relayHub.createRelayHandler();
      const observerRelayHandler = relayHub.createRelayHandler();

      const { server, serverTransport } = createServerAndTransport(
        serverPrivateKey,
        EncryptionMode.OPTIONAL,
        GiftWrapMode.OPTIONAL,
        serverRelayHandler,
      );
      await server.connect(serverTransport);

      const { client, clientNostrTransport } = createClientAndTransport(
        clientPrivateKey,
        serverPublicKey,
        EncryptionMode.REQUIRED,
        GiftWrapMode.OPTIONAL,
        true,
        clientRelayHandler,
      );

      observerRelayHandler.subscribe(
        [{ kinds: [GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND] }],
        (event) => {
          // Collect only client->server envelopes by matching recipient tag.
          // Client->server has a `p` tag of the server pubkey.
          const pTags = event.tags.filter((t) => t[0] === 'p');
          if (pTags.some((t) => t[1] === serverPublicKey)) {
            giftWrapKindsObserved.push(event.kind);
          }
        },
      );

      await client.connect(clientNostrTransport);

      // First request: should default to persistent gift wrap (1059)
      await client.listTools();
      await waitFor({
        produce: () =>
          giftWrapKindsObserved.includes(GIFT_WRAP_KIND)
            ? giftWrapKindsObserved
            : undefined,
      });
      // Second request: after server response tags, should switch to ephemeral gift wrap (21059)
      await client.listTools();
      await waitFor({
        produce: () =>
          giftWrapKindsObserved.includes(EPHEMERAL_GIFT_WRAP_KIND)
            ? giftWrapKindsObserved
            : undefined,
        timeoutMs: 5_000,
      });

      expect(giftWrapKindsObserved).toContain(GIFT_WRAP_KIND);
      expect(giftWrapKindsObserved).toContain(EPHEMERAL_GIFT_WRAP_KIND);

      await client.close();
      await server.close();
    },
    30000,
  );
});
