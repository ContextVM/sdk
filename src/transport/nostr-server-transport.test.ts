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
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import {
  CTXVM_MESSAGES_KIND,
  INITIALIZE_METHOD,
  PROFILE_METADATA_KIND,
  PROMPTS_LIST_KIND,
  RELAY_LIST_METADATA_KIND,
  RESOURCES_LIST_KIND,
  RESOURCETEMPLATES_LIST_KIND,
  SERVER_ANNOUNCEMENT_KIND,
  TOOLS_LIST_KIND,
  COMMON_SCHEMA_META_NAMESPACE,
} from '../core/constants.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';
import { computeCommonSchemaHash } from '../core/index.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { z } from 'zod';
import {
  injectClientPubkey,
  injectRequestEventId,
} from '../core/utils/utils.js';
import {
  isJSONRPCRequest,
  JSONRPCMessage,
  JSONRPCResponse,
  JSONRPCErrorResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { withServerPayments } from '../payments/server-transport-payments.js';

import { withCommonToolSchemas } from './server-transport-common-schemas.js';
import { FakePaymentProcessor } from '../payments/fake-payment-processor.js';
import {
  spawnMockRelay,
  spawnMockRelayOnPort,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';
import { waitFor } from '../core/utils/test.utils.js';
import { OpenStreamAbortFrame } from './open-stream/types.js';

describe.serial('NostrServerTransport', () => {
  let relay: MockRelayInstance;
  let relayUrl: string;
  let httpUrl: string;

  beforeAll(async () => {
    // Start mock relay with dynamic port
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

  const waitForNostrEvent = async (params: {
    relayPool: ApplesauceRelayPool;
    filters: Array<Record<string, unknown>>;
    where: (event: NostrEvent) => boolean;
    timeoutMs?: number;
  }): Promise<NostrEvent> => {
    const { relayPool, filters, where, timeoutMs = 5000 } = params;

    return await new Promise<NostrEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for matching Nostr event'));
      }, timeoutMs);

      void relayPool.subscribe(filters as never, (event) => {
        if (where(event)) {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });
  };

  // Helper function to create a client and its transport
  const createClientAndTransport = (
    privateKey: string,
    name: string,
    serverPublicKey: string,
    encryptionMode?: EncryptionMode,
    giftWrapMode?: GiftWrapMode,
  ) => {
    const client = new Client({ name, version: '1.0.0' });
    const clientNostrTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(privateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode, // Enable encryption
      giftWrapMode,
    });
    return { client, clientNostrTransport };
  };

  test.serial(
    'should publish a server announcement event when isPublicServer is true',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

      // Create a mock MCP server
      const server = new McpServer({
        name: 'Test Server',
        version: '1.0.0',
      });

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverInfo: {
          name: 'Test Server',
          website: 'http://localhost',
        },
        isPublicServer: true,
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const announcementEvent = await waitForNostrEvent({
        relayPool,
        filters: [
          { kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] },
        ],
        where: () => true,
        timeoutMs: 5000,
      });

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
    },
    5000,
  );

  test.serial(
    'should include server PMI and cap tags in announcement and tools list events when payments are configured',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

      const server = new McpServer({ name: 'Paid Server', version: '1.0.0' });
      server.registerTool(
        'add',
        {
          title: 'Addition Tool',
          description: 'Add two numbers',
          inputSchema: { a: z.number(), b: z.number() },
        },
        async ({ a, b }) => ({
          content: [{ type: 'text', text: String(a + b) }],
        }),
      );

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        isPublicServer: true,
        serverInfo: { name: 'Paid Server' },
        encryptionMode: EncryptionMode.DISABLED,
      });

      withServerPayments(transport, {
        processors: [
          new FakePaymentProcessor({ pmi: 'pmi:B', verifyDelayMs: 1 }),
          new FakePaymentProcessor({ pmi: 'pmi:C', verifyDelayMs: 1 }),
        ],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 123,
            currencyUnit: 'sats',
          },
        ],
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const events: NostrEvent[] = [];
      await relayPool.subscribe(
        [
          {
            kinds: [
              SERVER_ANNOUNCEMENT_KIND,
              TOOLS_LIST_KIND,
              RESOURCES_LIST_KIND,
              RESOURCETEMPLATES_LIST_KIND,
              PROMPTS_LIST_KIND,
            ],
            authors: [serverPublicKey],
          },
        ],
        (event) => {
          events.push(event);
        },
      );

      await waitFor({
        produce: () =>
          events.length >= 2 &&
          events.some((ev) => ev.kind === SERVER_ANNOUNCEMENT_KIND) &&
          events.some((ev) => ev.kind === TOOLS_LIST_KIND)
            ? events
            : undefined,
        timeoutMs: 5_000,
      });

      const announcement = events.find(
        (ev) => ev.kind === SERVER_ANNOUNCEMENT_KIND,
      );
      expect(announcement).toBeDefined();
      expect(announcement!.tags).toEqual(
        expect.arrayContaining([
          ['pmi', 'pmi:B'],
          ['pmi', 'pmi:C'],
          ['cap', 'tool:add', '123', 'sats'],
        ]),
      );

      const toolsList = events.find((ev) => ev.kind === TOOLS_LIST_KIND);
      expect(toolsList).toBeDefined();
      expect(toolsList!.tags).toEqual(
        expect.arrayContaining([['cap', 'tool:add', '123', 'sats']]),
      );

      // Only assert list kinds the test server can actually respond to.
      // Some MCP server instances may not implement resources/templates/list.
      // If present, it should include pricing tags.
      const resourceTemplatesList = events.find(
        (ev) => ev.kind === RESOURCETEMPLATES_LIST_KIND,
      );
      if (resourceTemplatesList) {
        expect(resourceTemplatesList.tags).toEqual(
          expect.arrayContaining([['cap', 'tool:add', '123', 'sats']]),
        );
      }

      await server.close();
      await relayPool.disconnect();
    },
    15000,
  );

  test.serial(
    'should publish relay list metadata by default for public servers',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

      const server = new McpServer({
        name: 'Test Server',
        version: '1.0.0',
      });

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverInfo: { name: 'Test Server' },
        isPublicServer: true,
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const relayListEvent = await waitForNostrEvent({
        relayPool,
        filters: [
          { kinds: [RELAY_LIST_METADATA_KIND], authors: [serverPublicKey] },
        ],
        where: () => true,
      });

      expect(relayListEvent.kind).toBe(RELAY_LIST_METADATA_KIND);
      expect(relayListEvent.tags).toEqual([['r', relayUrl]]);

      await server.close();
      await relayPool.disconnect();
    },
    10000,
  );

  test.serial(
    'should publish relay list metadata by default for private servers',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

      const server = new McpServer({
        name: 'Test Server',
        version: '1.0.0',
      });

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverInfo: { name: 'Test Server' },
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const relayListEvent = await waitForNostrEvent({
        relayPool,
        filters: [
          { kinds: [RELAY_LIST_METADATA_KIND], authors: [serverPublicKey] },
        ],
        where: () => true,
      });

      expect(relayListEvent.kind).toBe(RELAY_LIST_METADATA_KIND);
      expect(relayListEvent.tags).toEqual([['r', relayUrl]]);

      await expect(
        waitForNostrEvent({
          relayPool,
          filters: [
            { kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] },
          ],
          where: () => true,
          timeoutMs: 750,
        }),
      ).rejects.toThrow('Timed out waiting for matching Nostr event');

      await server.close();
      await relayPool.disconnect();
    },
    10000,
  );

  test.serial(
    'should publish profile metadata when configured even if server is not announced',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

      const profileMetadata = {
        name: 'Private Profile Server',
        about: 'Publishes kind 0 without public announcements',
        website: 'https://example.com/private-server',
      };

      const server = new McpServer({
        name: 'Profile Metadata Server',
        version: '1.0.0',
      });

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        profileMetadata,
        bootstrapRelayUrls: [],
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const profileEvent = await waitForNostrEvent({
        relayPool,
        filters: [
          { kinds: [PROFILE_METADATA_KIND], authors: [serverPublicKey] },
        ],
        where: () => true,
      });

      expect(profileEvent.kind).toBe(PROFILE_METADATA_KIND);
      expect(profileEvent.pubkey).toBe(serverPublicKey);
      expect(profileEvent.tags).toEqual([]);
      expect(JSON.parse(profileEvent.content)).toEqual(profileMetadata);

      await expect(
        waitForNostrEvent({
          relayPool,
          filters: [
            { kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] },
          ],
          where: () => true,
          timeoutMs: 750,
        }),
      ).rejects.toThrow('Timed out waiting for matching Nostr event');

      await server.close();
      await relayPool.disconnect();
    },
    10000,
  );

  test('should not publish relay list metadata when publishRelayList is false', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverInfo: { name: 'Test Server' },
      isPublicServer: true,
      publishRelayList: false,
    });

    await server.connect(transport);

    const relayPool = new ApplesauceRelayPool([relayUrl]);
    await relayPool.connect();

    await expect(
      waitForNostrEvent({
        relayPool,
        filters: [
          { kinds: [RELAY_LIST_METADATA_KIND], authors: [serverPublicKey] },
        ],
        where: () => true,
        timeoutMs: 750,
      }),
    ).rejects.toThrow('Timed out waiting for matching Nostr event');

    await server.close();
    await relayPool.disconnect();
  }, 10000);

  test('should publish discoverability metadata to bootstrap relays without advertising them in kind 10002', async () => {
    const bootstrap = await spawnMockRelayOnPort(relay.port + 1);
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverInfo: { name: 'Test Server' },
      isPublicServer: true,
      bootstrapRelayUrls: [bootstrap.relayUrl],
    });

    await server.connect(transport);

    const bootstrapPool = new ApplesauceRelayPool([bootstrap.relayUrl]);
    await bootstrapPool.connect();

    const bootstrapAnnouncement = await waitForNostrEvent({
      relayPool: bootstrapPool,
      filters: [
        { kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] },
      ],
      where: () => true,
    });
    const bootstrapRelayList = await waitForNostrEvent({
      relayPool: bootstrapPool,
      filters: [
        { kinds: [RELAY_LIST_METADATA_KIND], authors: [serverPublicKey] },
      ],
      where: () => true,
    });

    expect(bootstrapAnnouncement.kind).toBe(SERVER_ANNOUNCEMENT_KIND);
    expect(bootstrapRelayList.tags).toEqual([['r', relayUrl]]);

    await server.close();
    await bootstrapPool.disconnect();
    bootstrap.stop();
  }, 15000);

  test('should allow connection for allowed public keys', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
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
      relayHandler: new ApplesauceRelayPool([relayUrl]),
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

    await expect(
      allowedClient.connect(allowedClientNostrTransport),
    ).resolves.toBeUndefined();
    await allowedClient.close();
    await server.close();
  }, 10000);

  test('should allow connection for disallowed public keys', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
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
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey], // Only allow the dummy key
      excludedCapabilities: [{ method: INITIALIZE_METHOD }],
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
    expect(result).toBe('connected');
    await server.close();
  }, 10000);

  test('should allow call excluded capabilities for disallowed public keys', async () => {
    // Use a unique server key per test to avoid cross-pollution with concurrent files.
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const allowedClientPublicKey = getPublicKey(
      hexToBytes(bytesToHex(generateSecretKey())), // Generate a dummy key for the allowed list
    );
    const disallowedClientPrivateKey = bytesToHex(generateSecretKey());

    // Use unique tool names to avoid collision with concurrent tests
    const uniqueSuffix = Math.random().toString(36).substring(2, 8);
    const toolAdd = `add_${uniqueSuffix}`;
    const toolDummy = `dummy_${uniqueSuffix}`;

    const server = new McpServer({
      name: 'Disallowed Server',
      version: '1.0.0',
    });

    // Add an addition tool
    server.registerTool(
      toolAdd,
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    server.registerTool(
      toolDummy,
      {
        title: 'Dummy Tool',
        description: 'Dummy description',
        inputSchema: {},
      },
      async () => ({
        content: [{ type: 'text', text: 'Dummy response' }],
      }),
    );

    const allowedTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      allowedPublicKeys: [allowedClientPublicKey], // Only allow the dummy key
      excludedCapabilities: [
        { method: 'tools/list' }, // Exclude specific capability
        { method: 'tools/call', name: toolDummy }, // Exclude specific capability
      ],
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

    await disallowedClient.connect(disallowedClientNostrTransport);

    // Wait for the server to be ready by checking we get the right tools
    const listToolsResult = await disallowedClient.listTools();

    // Validate we got tools from OUR server (not a concurrent test's server)
    const hasOurAddTool = listToolsResult.tools.some((t) => t.name === toolAdd);
    const hasOurDummyTool = listToolsResult.tools.some(
      (t) => t.name === toolDummy,
    );
    expect(hasOurAddTool).toBe(true);
    expect(hasOurDummyTool).toBe(true);

    const timeoutPromise = new Promise<string>((resolve) => {
      sleep(1000).then(() => {
        resolve('timeout');
      });
    });

    const callRestrictedToolResult = disallowedClient.callTool({
      name: toolAdd,
      arguments: { a: 1, b: 2 },
    });

    const callExcludedToolResult = disallowedClient.callTool({
      name: toolDummy,
      arguments: {},
    });

    const result = await Promise.race([
      callRestrictedToolResult,
      timeoutPromise,
    ]);
    expect(result).toBe('timeout');
    expect(listToolsResult).toBeDefined();
    await expect(callExcludedToolResult).resolves.toBeDefined();
    await disallowedClient.close();
    await disallowedClientNostrTransport.close();
    await server.close();
  }, 10000);

  test.serial(
    'should include all server metadata tags in announcement events',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

      const server = new McpServer({
        name: 'Test Server',
        version: '1.0.0',
      });

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverInfo: {
          name: 'Test Server',
          about: 'A test server for CTXVM',
          website: 'http://localhost',
          picture: 'http://localhost/logo.png',
        },
        isPublicServer: true,
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const announcementEvent = await waitForNostrEvent({
        relayPool,
        filters: [
          { kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] },
        ],
        where: () => true,
        timeoutMs: 5000,
      });

      expect(announcementEvent.tags).toBeDefined();
      expect(Array.isArray(announcementEvent.tags)).toBe(true);

      // Convert tags to an object for easier testing
      const tagsObject: { [key: string]: string } = {};
      announcementEvent.tags.forEach((tag: string[]) => {
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
      const supportEncryptionTag = announcementEvent.tags.find(
        (tag: string[]) => tag.length === 1 && tag[0] === 'support_encryption',
      );
      expect(supportEncryptionTag).toBeDefined();

      await server.close();
      await relayPool.disconnect();
    },
    5000,
  );

  test.serial(
    'should include only name tag when serverInfo is minimal and encryption disabled',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

      const server = new McpServer({
        name: 'Minimal Server',
        version: '1.0.0',
      });

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverInfo: {
          name: 'Minimal Server',
        },
        encryptionMode: EncryptionMode.DISABLED, // Disable encryption
        isPublicServer: true,
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const announcementEvent = await waitForNostrEvent({
        relayPool,
        filters: [
          { kinds: [SERVER_ANNOUNCEMENT_KIND], authors: [serverPublicKey] },
        ],
        where: () => true,
        timeoutMs: 5000,
      });

      expect(announcementEvent.tags).toBeDefined();

      // Check that only the name tag is present
      const nameTags = announcementEvent.tags.filter(
        (tag: string[]) => tag.length >= 2 && tag[0] === 'name',
      );
      expect(nameTags.length).toBe(1);
      expect(nameTags[0][1]).toBe('Minimal Server');

      // Check that no support_encryption tag is present
      const supportEncryptionTag = announcementEvent.tags.find(
        (tag: string[]) => tag.length === 1 && tag[0] === 'support_encryption',
      );
      expect(supportEncryptionTag).toBeUndefined();

      await server.close();
      await relayPool.disconnect();
    },
    5000,
  );

  test('should store server initialize event after receiving it', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const clientPrivateKey = bytesToHex(generateSecretKey());

    // Create a mock MCP server
    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
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

    const storedInitializeEvent = await waitFor({
      produce: () => clientNostrTransport.getServerInitializeEvent(),
      timeoutMs: 5_000,
    });
    expect(storedInitializeEvent).toBeDefined();
    expect(storedInitializeEvent).not.toBeNull();
    expect(storedInitializeEvent!.pubkey).toBe(serverPublicKey);

    // Verify that the event content contains the expected result
    const content = JSON.parse(storedInitializeEvent!.content);
    expect(content.result).toBeDefined();
    expect(content.result).not.toBeNull();
    expect(content.result.protocolVersion).toBeDefined();
    expect(content.result.capabilities).toBeDefined();

    await clientNostrTransport.close();
    await server.close();
  }, 10000);

  test('should inject client public key into _meta field when injectClientPubkey is enabled', () => {
    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0' as const,
      id: 'test-id',
      method: 'test/method',
      params: {
        someParam: 'value',
      },
    };

    const clientPubkey = 'test-client-pubkey';

    // Test with object params - function mutates in-place
    injectClientPubkey(testMessage, clientPubkey);
    if (isJSONRPCRequest(testMessage)) {
      expect(testMessage.params?._meta).toBeDefined();
      expect(testMessage.params?._meta?.clientPubkey).toBe(clientPubkey);
      expect(testMessage.params?.someParam).toBe('value'); // Original params preserved
    }
  });

  test('should preserve existing _meta when injecting client public key', () => {
    const messageWithMeta: JSONRPCMessage = {
      jsonrpc: '2.0' as const,
      id: 'test-id-2',
      method: 'test/method',
      params: {
        _meta: {
          progressToken: 'existing-token',
        },
      },
    };

    const clientPubkey = 'test-client-pubkey';

    // Function mutates in-place
    injectClientPubkey(messageWithMeta, clientPubkey);
    expect(messageWithMeta.params?._meta).toBeDefined();
    expect(messageWithMeta.params?._meta?.clientPubkey).toBe(clientPubkey);
    expect(messageWithMeta.params?._meta?.progressToken).toBe('existing-token'); // Existing meta preserved
  });

  test('should handle messages without params', () => {
    const messageWithoutParams: JSONRPCMessage = {
      jsonrpc: '2.0' as const,
      id: 'test-id-3',
      method: 'test/method',
    };

    const clientPubkey = 'test-client-pubkey';

    // Should not throw when params is undefined
    expect(() =>
      injectClientPubkey(messageWithoutParams, clientPubkey),
    ).not.toThrow();
    expect(messageWithoutParams.params).toBeUndefined();
  });

  test('should inject request event id into _meta field', () => {
    const testMessage: JSONRPCMessage = {
      jsonrpc: '2.0' as const,
      id: 'test-id-4',
      method: 'test/method',
      params: {
        someParam: 'value',
      },
    };

    injectRequestEventId(testMessage, 'event-123');

    if (isJSONRPCRequest(testMessage)) {
      expect(testMessage.params?._meta?.requestEventId).toBe('event-123');
      expect(testMessage.params?.someParam).toBe('value');
    }
  });

  test('should preserve existing _meta when injecting request event id', () => {
    const messageWithMeta: JSONRPCMessage = {
      jsonrpc: '2.0' as const,
      id: 'test-id-5',
      method: 'test/method',
      params: {
        _meta: {
          progressToken: 'existing-token',
        },
      },
    };

    injectRequestEventId(messageWithMeta, 'event-456');

    expect(messageWithMeta.params?._meta?.requestEventId).toBe('event-456');
    expect(messageWithMeta.params?._meta?.progressToken).toBe('existing-token');
  });

  test.serial(
    'should expose inbound request event by requestEventId during inbound processing and clean it up after response when injection is enabled',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

      let observedEventId: string | undefined;
      let observedEventPubkey: string | undefined;
      let observedContextDuringMiddleware = false;

      const server = new McpServer({
        name: 'Test Server',
        version: '1.0.0',
      });

      server.registerTool(
        'inspect-request-event',
        {
          title: 'Inspect Request Event',
          description: 'Reads the inbound Nostr request event from context',
          inputSchema: {},
        },
        async () => {
          return {
            content: [{ type: 'text', text: observedEventId ?? 'missing' }],
          };
        },
      );

      const serverTransport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        injectClientPubkey: true,
        injectRequestEventId: true,
        inboundMiddleware: async (message, _ctx, forward) => {
          if (isJSONRPCRequest(message) && message.method === 'tools/call') {
            const requestEventId = message.params?._meta?.requestEventId;
            expect(typeof requestEventId).toBe('string');

            const requestEvent = serverTransport.getNostrRequestEvent(
              String(requestEventId),
            );

            expect(requestEvent).toBeDefined();

            observedEventId = String(requestEventId);
            observedEventPubkey = requestEvent?.pubkey;
            observedContextDuringMiddleware = true;
          }

          await forward(message);
        },
      });

      await server.connect(serverTransport);

      const { client, clientNostrTransport } = createClientAndTransport(
        clientPrivateKey,
        'Test Client',
        serverPublicKey,
      );

      await client.connect(clientNostrTransport);
      await client.callTool({
        name: 'inspect-request-event',
        arguments: {},
      });

      expect(observedContextDuringMiddleware).toBe(true);
      expect(observedEventId).toBeDefined();
      expect(observedEventPubkey).toBe(clientPublicKey);
      await waitFor({
        produce: () =>
          serverTransport.getNostrRequestEvent(observedEventId!) ?? undefined,
        timeoutMs: 100,
        intervalMs: 10,
      }).catch(() => undefined);
      expect(
        serverTransport.getNostrRequestEvent(observedEventId!),
      ).toBeUndefined();

      await clientNostrTransport.close();
      await server.close();
    },
    10000,
  );

  test.serial(
    'should expose inbound request event to tool handler via _meta.requestEventId when injectRequestEventId is enabled',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

      let toolReceivedEventId: string | undefined;
      let toolReceivedPubkey: string | undefined;

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        injectRequestEventId: true,
      });

      const server = new McpServer({
        name: 'Test Server',
        version: '1.0.0',
      });

      server.registerTool(
        'whoami',
        {
          title: 'Who Am I',
          description:
            'Returns the public key of the client that invoked this tool.',
          inputSchema: {},
        },
        async (_args, extra) => {
          const requestEventId = extra._meta?.requestEventId;
          if (requestEventId) {
            const requestEvent = transport.getNostrRequestEvent(
              String(requestEventId),
            );
            toolReceivedEventId = String(requestEventId);
            toolReceivedPubkey = requestEvent?.pubkey;
          }
          return {
            content: [{ type: 'text', text: toolReceivedPubkey ?? 'unknown' }],
          };
        },
      );

      await server.connect(transport);

      const { client, clientNostrTransport } = createClientAndTransport(
        clientPrivateKey,
        'Test Client',
        serverPublicKey,
      );

      await client.connect(clientNostrTransport);
      await client.callTool({
        name: 'whoami',
        arguments: {},
      });

      expect(toolReceivedEventId).toBeDefined();
      expect(typeof toolReceivedEventId).toBe('string');
      expect(toolReceivedPubkey).toBe(clientPublicKey);

      // Verify cleanup after response
      await waitFor({
        produce: () =>
          transport.getNostrRequestEvent(toolReceivedEventId!) ?? undefined,
        timeoutMs: 100,
        intervalMs: 10,
      }).catch(() => undefined);
      expect(
        transport.getNostrRequestEvent(toolReceivedEventId!),
      ).toBeUndefined();

      await clientNostrTransport.close();
      await server.close();
    },
    10000,
  );

  test.serial(
    'should not inject request event id when request event injection is disabled',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());

      let observedRequestEventId: unknown;
      let observedStoredRequestEvent: NostrEvent | undefined;

      const server = new McpServer({
        name: 'Test Server',
        version: '1.0.0',
      });

      server.registerTool(
        'inspect-request-event',
        {
          title: 'Inspect Request Event',
          description: 'Reads the inbound Nostr request event from context',
          inputSchema: {},
        },
        async () => {
          return {
            content: [{ type: 'text', text: 'ok' }],
          };
        },
      );

      const serverTransport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        inboundMiddleware: async (message, _ctx, forward) => {
          if (isJSONRPCRequest(message) && message.method === 'tools/call') {
            observedRequestEventId = message.params?._meta?.requestEventId;
            observedStoredRequestEvent = serverTransport.getNostrRequestEvent(
              String(message.id),
            );
          }

          await forward(message);
        },
      });

      await server.connect(serverTransport);

      const { client, clientNostrTransport } = createClientAndTransport(
        clientPrivateKey,
        'Test Client',
        serverPublicKey,
      );

      await client.connect(clientNostrTransport);
      await client.callTool({
        name: 'inspect-request-event',
        arguments: {},
      });

      expect(observedRequestEventId).toBeUndefined();
      expect(observedStoredRequestEvent).toBeUndefined();

      await clientNostrTransport.close();
      await server.close();
    },
    10000,
  );

  test.serial(
    'should clean up dropped inbound request routes immediately when middleware does not forward',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

      let observedRequestEventId: string | undefined;

      const serverTransport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        injectRequestEventId: true,
        inboundMiddleware: async (message) => {
          if (isJSONRPCRequest(message) && message.method === 'tools/call') {
            observedRequestEventId = String(
              message.params?._meta?.requestEventId,
            );
          }
        },
      });

      const requestEvent: NostrEvent = {
        id: 'dropped-request-event',
        pubkey: clientPublicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: CTXVM_MESSAGES_KIND,
        tags: [],
        content: JSON.stringify({
          jsonrpc: '2.0',
          id: 'dropped-request',
          method: 'tools/call',
          params: {
            name: 'inspect-request-event',
            arguments: {},
          },
        }),
        sig: 'sig',
      };

      await (
        serverTransport as unknown as {
          inboundCoordinator: {
            authorizeAndProcessEvent: (
              event: NostrEvent,
              isEncrypted: boolean,
              mcpMessage: JSONRPCMessage,
              wrapKind?: number,
            ) => Promise<void>;
          }
        }
      ).inboundCoordinator.authorizeAndProcessEvent(
        requestEvent,
        false,
        JSON.parse(requestEvent.content) as JSONRPCMessage,
      );

      await sleep(100);
      expect(observedRequestEventId).toBeDefined();
      await waitFor({
        produce: () =>
          observedRequestEventId
            ? serverTransport.getNostrRequestEvent(observedRequestEventId)
            : undefined,
        timeoutMs: 100,
        intervalMs: 10,
      }).catch(() => undefined);
      expect(
        observedRequestEventId
          ? serverTransport.getNostrRequestEvent(observedRequestEventId)
          : undefined,
      ).toBeUndefined();

      await serverTransport.close();
    },
    10000,
  );

  test('should include common tags in initialize response', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const clientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverInfo: {
        name: 'Test Server',
        about: 'A test server for CTXVM',
        website: 'http://localhost',
        picture: 'http://localhost/logo.png',
      },
      encryptionMode: EncryptionMode.OPTIONAL, // Enable encryption
    });

    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      'Test Client',
      serverPublicKey,
      EncryptionMode.DISABLED, // Enable encryption
    );

    // Subscribe to all events from server to capture initialize response
    let initializeResponseEvent: NostrEvent | null = null;
    const relayPool = new ApplesauceRelayPool([relayUrl]);
    await relayPool.connect();

    await relayPool.subscribe([{ authors: [serverPublicKey] }], (event) => {
      // Check if this is an initialize response
      try {
        const content = JSON.parse(event.content);
        if (content.result?.protocolVersion) {
          initializeResponseEvent = event;
        }
      } catch {
        // Ignore parse errors
      }
    });

    // Connect client (triggers initialize handshake)
    await client.connect(clientNostrTransport);

    const capturedInitializeResponseEvent = await waitFor({
      produce: () => initializeResponseEvent ?? undefined,
      timeoutMs: 5_000,
    });

    expect(capturedInitializeResponseEvent).toBeDefined();
    expect(initializeResponseEvent!.tags).toBeDefined();

    // Convert tags to an object for easier testing
    const tagsObject: { [key: string]: string } = {};
    capturedInitializeResponseEvent.tags.forEach((tag: string[]) => {
      if (
        tag.length >= 2 &&
        typeof tag[0] === 'string' &&
        typeof tag[1] === 'string'
      ) {
        tagsObject[tag[0]] = tag[1];
      }
    });

    // Verify all common tags are present
    expect(tagsObject.name).toBe('Test Server');
    expect(tagsObject.about).toBe('A test server for CTXVM');
    expect(tagsObject.website).toBe('http://localhost');
    expect(tagsObject.picture).toBe('http://localhost/logo.png');

    // Verify support_encryption tag is present
    const supportEncryptionTag = capturedInitializeResponseEvent.tags.find(
      (tag: string[]) => tag.length === 1 && tag[0] === 'support_encryption',
    );
    expect(supportEncryptionTag).toBeDefined();

    await client.close();
    await server.close();
    await relayPool.disconnect();
  }, 10000);

  test('should include support_encryption_ephemeral tag in initialize response when giftWrapMode is EPHEMERAL', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const clientPrivateKey = bytesToHex(generateSecretKey());

    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverInfo: { name: 'Test Server' },
      encryptionMode: EncryptionMode.OPTIONAL,
      giftWrapMode: GiftWrapMode.EPHEMERAL,
    });

    await server.connect(serverTransport);

    const { client, clientNostrTransport } = createClientAndTransport(
      clientPrivateKey,
      'Test Client',
      serverPublicKey,
      EncryptionMode.OPTIONAL,
      GiftWrapMode.EPHEMERAL,
    );

    await client.connect(clientNostrTransport);

    const initializeResponseEvent = await waitFor({
      produce: () => clientNostrTransport.getServerInitializeEvent(),
      timeoutMs: 5_000,
    });
    expect(initializeResponseEvent).toBeDefined();
    const supportEncryptionEphemeralTag = initializeResponseEvent!.tags.find(
      (tag: string[]) =>
        tag.length === 1 && tag[0] === 'support_encryption_ephemeral',
    );
    expect(supportEncryptionEphemeralTag).toBeDefined();

    await client.close();
    await server.close();
  }, 10000);

  test('should delete announcements per-kind without cross-kind accumulation', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverInfo: {
        name: 'Test Server',
        website: 'http://localhost',
      },
      isPublicServer: true,
    });

    await server.connect(serverTransport);

    // Collect all announcement events before deletion
    const announcementEventsByKind: { [kind: number]: NostrEvent[] } = {};
    const relayPool = new ApplesauceRelayPool([relayUrl]);
    await relayPool.connect();

    const kinds = [
      SERVER_ANNOUNCEMENT_KIND,
      TOOLS_LIST_KIND,
      RESOURCES_LIST_KIND,
      RESOURCETEMPLATES_LIST_KIND,
      PROMPTS_LIST_KIND,
    ];

    for (const kind of kinds) {
      const events: NostrEvent[] = [];
      await relayPool.subscribe(
        [{ kinds: [kind], authors: [serverPublicKey] }],
        (event) => {
          events.push(event);
        },
      );
      const settledEvents = await waitFor({
        produce: () => (events.length > 0 ? events : undefined),
        timeoutMs: 2_000,
      }).catch(() => undefined);
      if (settledEvents && settledEvents.length > 0) {
        announcementEventsByKind[kind] = events;
      }
    }

    // Delete announcements
    const deletionEvents =
      await serverTransport.deleteAnnouncement('Test deletion');

    // Verify each deletion event only references events of its kind
    for (const deletionEvent of deletionEvents) {
      const referencedEventIds = deletionEvent.tags
        .filter((tag: string[]) => tag[0] === 'e')
        .map((tag: string[]) => tag[1]);

      // Find which kind this deletion event is for
      let matchedKind: number | undefined;
      for (const [kind, events] of Object.entries(announcementEventsByKind)) {
        const kindNum = Number(kind);
        const eventIds = events.map((ev) => ev.id);
        if (referencedEventIds.some((id) => eventIds.includes(id))) {
          matchedKind = kindNum;
          break;
        }
      }

      expect(matchedKind).toBeDefined();

      // Verify all referenced events are of the same kind
      if (matchedKind !== undefined && announcementEventsByKind[matchedKind]) {
        const expectedEventIds = announcementEventsByKind[matchedKind].map(
          (ev) => ev.id,
        );
        const allMatch = referencedEventIds.every((id) =>
          expectedEventIds.includes(id),
        );
        expect(allMatch).toBe(true);
      }
    }

    await server.close();
    await relayPool.disconnect();
  }, 15000);

  test('should send correlated notifications (with e tag) via sendNotification()', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));

    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

    const server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
    });
    await server.connect(serverTransport);

    // Establish a session by connecting a real client transport.
    const client = new Client({ name: 'Notify Client', version: '1.0.0' });
    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
    });
    await client.connect(clientTransport);

    // Observe outgoing events from server.
    // NOTE: applesauce subscription setup is async; ensure it's active before sending.
    const relayPool = new ApplesauceRelayPool([relayUrl]);
    await relayPool.connect();
    await new Promise<void>((resolve) => {
      relayPool.subscribe(
        [
          {
            kinds: [CTXVM_MESSAGES_KIND],
            authors: [serverPublicKey],
            limit: 0,
          },
        ],
        () => {},
        () => resolve(),
      );
      // Safety: EOSE may not fire in some edge conditions; don't hang the test.
      setTimeout(resolve, 250);
    });

    const sentPromise = waitForNostrEvent({
      relayPool,
      filters: [{ kinds: [CTXVM_MESSAGES_KIND], authors: [serverPublicKey] }],
      where: (ev) => {
        try {
          const msg = JSON.parse(ev.content) as { method?: string };
          return msg.method === 'notifications/payment_required';
        } catch {
          return false;
        }
      },
      timeoutMs: 5000,
    });

    const correlatedEventId = 'f'.repeat(64);
    await serverTransport.sendNotification(
      clientPublicKey,
      {
        jsonrpc: '2.0',
        method: 'notifications/payment_required',
        params: { amount: 1, pay_req: 'test', pmi: 'test' },
      },
      correlatedEventId,
    );

    const sent = await sentPromise;

    expect(
      sent.tags.some((t) => t[0] === 'e' && t[1] === correlatedEventId),
    ).toBe(true);
    expect(
      sent.tags.some((t) => t[0] === 'p' && t[1] === clientPublicKey),
    ).toBe(true);

    await client.close();
    await server.close();
    await relayPool.disconnect();
  }, 15000);

  test('removes the client session after an open-stream probe timeout abort', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(generateSecretKey());

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
      openStream: { enabled: true },
    });

    const internalState = serverTransport.getInternalStateForTesting();
    internalState.sessionStore.getOrCreateSession(clientPublicKey, false);

    (
      serverTransport as unknown as {
        inboundCoordinator: {
          handleIncomingRequest: (
            event: NostrEvent,
            eventId: string,
            request: {
              id: string;
              params?: { _meta?: { progressToken?: string } };
            },
            clientPubkey: string,
            wrapKind?: number,
          ) => void;
        }
      }
    ).inboundCoordinator.handleIncomingRequest(
      {
        id: 'b'.repeat(64),
        pubkey: clientPublicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: '',
        sig: 'c'.repeat(128),
      } as NostrEvent,
      'a'.repeat(64),
      {
        id: 'request-1',
        params: {
          _meta: {
            progressToken: 'progress-1',
          },
        },
      },
      clientPublicKey,
    );

    const writer = internalState.openStreamWriters.get('a'.repeat(64));
    expect(writer).toBeDefined();

    await writer!.abort('Probe timeout');

    expect(internalState.sessionStore.hasSession(clientPublicKey)).toBe(false);
    expect(internalState.openStreamWriters.has('a'.repeat(64))).toBe(false);
  });

  test('flushes pending open-stream responses after probe-timeout session eviction', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(generateSecretKey());

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
      openStream: { enabled: true },
    });

    const internalState = serverTransport.getInternalStateForTesting() as {
      sessionStore: {
        getOrCreateSession: (
          clientPubkey: string,
          isEncrypted: boolean,
        ) => unknown;
        hasSession: (clientPubkey: string) => boolean;
      };
      pendingOpenStreamResponses: Map<string, JSONRPCResponse>;
      openStreamWriters: Map<
        string,
        { abort: (reason?: string) => Promise<void> }
      >;
    };
    internalState.sessionStore.getOrCreateSession(clientPublicKey, false);

    const handledResponses: JSONRPCResponse[] = [];
    (
      serverTransport as unknown as {
        outboundResponseRouter: {
          route: (response: JSONRPCResponse | JSONRPCErrorResponse) => Promise<void>;
        }
      }
    ).outboundResponseRouter.route = async (response: JSONRPCResponse | JSONRPCErrorResponse): Promise<void> => {
      handledResponses.push(response as JSONRPCResponse);
    };

    (
      serverTransport as unknown as {
        inboundCoordinator: {
          handleIncomingRequest: (
            event: NostrEvent,
            eventId: string,
            request: {
              id: string;
              params?: { _meta?: { progressToken?: string } };
            },
            clientPubkey: string,
            wrapKind?: number,
          ) => void;
        }
      }
    ).inboundCoordinator.handleIncomingRequest(
      {
        id: 'b'.repeat(64),
        pubkey: clientPublicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: '',
        sig: 'c'.repeat(128),
      } as NostrEvent,
      'a'.repeat(64),
      {
        id: 'request-1',
        params: {
          _meta: {
            progressToken: 'progress-1',
          },
        },
      },
      clientPublicKey,
    );

    internalState.pendingOpenStreamResponses.set('a'.repeat(64), {
      jsonrpc: '2.0',
      id: 'request-1',
      result: {
        content: [{ type: 'text', text: 'done' }],
      },
    });

    const writer = internalState.openStreamWriters.get('a'.repeat(64));
    expect(writer).toBeDefined();

    await writer!.abort('Probe timeout');
    await sleep(50);

    expect(internalState.sessionStore.hasSession(clientPublicKey)).toBe(false);
    expect(handledResponses).toHaveLength(1);
    expect(internalState.pendingOpenStreamResponses.has('a'.repeat(64))).toBe(
      false,
    );
  });

  test('flushes pending open-stream responses after abort frame publication completes', async () => {
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(generateSecretKey());

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
      openStream: { enabled: true },
    });

    const internalState = serverTransport.getInternalStateForTesting() as {
      sessionStore: {
        getOrCreateSession: (
          clientPubkey: string,
          isEncrypted: boolean,
        ) => unknown;
      };
      pendingOpenStreamResponses: Map<string, JSONRPCResponse>;
      openStreamWriters: Map<
        string,
        { abort: (reason?: string) => Promise<void> }
      >;
    };
    internalState.sessionStore.getOrCreateSession(clientPublicKey, false);

    const events: string[] = [];

    (
      serverTransport as unknown as {
        sendNotification: (
          clientPubkey: string,
          notification: JSONRPCMessage,
          correlatedEventId?: string,
        ) => Promise<void>;
      }
    ).sendNotification = async (
      _clientPubkey: string,
      notification: JSONRPCMessage,
    ): Promise<void> => {
      if (
        'method' in notification &&
        notification.method === 'notifications/progress' &&
        (notification.params?.cvm as OpenStreamAbortFrame).frameType === 'abort'
      ) {
        events.push('abort-frame');
      }
    };

    (
      serverTransport as unknown as {
        handleResponse: (response: JSONRPCResponse) => Promise<void>;
      }
    ).handleResponse = async (_response: JSONRPCResponse): Promise<void> => {
      events.push('final-response');
    };

    (
      serverTransport as unknown as {
        handleIncomingRequest: (
          event: NostrEvent,
          eventId: string,
          request: {
            id: string;
            params?: { _meta?: { progressToken?: string } };
          },
          clientPubkey: string,
          wrapKind?: number,
        ) => void;
      }
    ).handleIncomingRequest(
      {
        id: 'b'.repeat(64),
        pubkey: clientPublicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: '',
        sig: 'c'.repeat(128),
      } as NostrEvent,
      'a'.repeat(64),
      {
        id: 'request-1',
        params: {
          _meta: {
            progressToken: 'progress-1',
          },
        },
      },
      clientPublicKey,
    );

    internalState.pendingOpenStreamResponses.set('a'.repeat(64), {
      jsonrpc: '2.0',
      id: 'request-1',
      result: {
        content: [{ type: 'text', text: 'done' }],
      },
    });

    const writer = internalState.openStreamWriters.get('a'.repeat(64));
    expect(writer).toBeDefined();

    await writer!.abort('Probe timeout');

    expect(events).toEqual(['abort-frame', 'final-response']);
  });

  test.serial(
    'withCommonToolSchemas injects schema hashes into direct and announced tools/list payloads',
    async () => {
      const serverPrivateKey = bytesToHex(generateSecretKey());
      const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
      const clientPrivateKey = bytesToHex(generateSecretKey());
      const uniqueSuffix = Math.random().toString(36).substring(2, 8);
      const commonToolName = `translate_text_${uniqueSuffix}`;
      const bespokeToolName = `bespoke_tool_${uniqueSuffix}`;

      const server = new McpServer({
        name: 'Common Schema Server',
        version: '1.0.0',
      });

      server.registerTool(
        commonToolName,
        {
          title: 'Translate Text',
          description: 'Translate text between languages',
          inputSchema: {
            text: z.string(),
            targetLanguage: z.string(),
          },
        },
        async ({ text, targetLanguage }) => ({
          content: [
            {
              type: 'text',
              text: `${targetLanguage}: ${text}`,
            },
          ],
        }),
      );

      server.registerTool(
        bespokeToolName,
        {
          title: 'Bespoke Tool',
          description: 'Do something custom',
          inputSchema: {
            query: z.string(),
          },
        },
        async ({ query }) => ({
          content: [{ type: 'text', text: query.toUpperCase() }],
        }),
      );

      const transport = new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverInfo: { name: 'Common Schema Server' },
        isPublicServer: true,
        encryptionMode: EncryptionMode.DISABLED,
      });

      withCommonToolSchemas(transport, {
        tools: [{ name: commonToolName }],
      });

      await server.connect(transport);

      const relayPool = new ApplesauceRelayPool([relayUrl]);
      await relayPool.connect();

      const toolsListEvent = await waitForNostrEvent({
        relayPool,
        filters: [{ kinds: [TOOLS_LIST_KIND], authors: [serverPublicKey] }],
        where: () => true,
      });

      const announcedToolsList = JSON.parse(toolsListEvent.content) as {
        tools: Array<Record<string, unknown>>;
      };
      const announcedCommonTool = announcedToolsList.tools.find(
        (tool) => tool.name === commonToolName,
      ) as Record<string, unknown> | undefined;
      const announcedBespokeTool = announcedToolsList.tools.find(
        (tool) => tool.name === bespokeToolName,
      ) as Record<string, unknown> | undefined;

      const { client, clientNostrTransport } = createClientAndTransport(
        clientPrivateKey,
        'Common-Schema Client',
        serverPublicKey,
        EncryptionMode.DISABLED,
      );

      await client.connect(clientNostrTransport);
      const listToolsResult = await client.listTools();

      const directCommonTool = listToolsResult.tools.find(
        (tool) => tool.name === commonToolName,
      );
      const directBespokeTool = listToolsResult.tools.find(
        (tool) => tool.name === bespokeToolName,
      );

      const expectedSchemaHash = computeCommonSchemaHash({
        name: directCommonTool!.name,
        inputSchema: directCommonTool!.inputSchema,
        outputSchema: directCommonTool!.outputSchema ?? undefined,
      });
      const iTags = toolsListEvent.tags.filter((tag) => tag[0] === 'i');
      const kTags = toolsListEvent.tags.filter((tag) => tag[0] === 'k');

      expect(directCommonTool?._meta).toMatchObject({
        [COMMON_SCHEMA_META_NAMESPACE]: {
          schemaHash: expectedSchemaHash,
        },
      });
      expect(
        directBespokeTool?._meta?.[COMMON_SCHEMA_META_NAMESPACE],
      ).toBeUndefined();

      expect(announcedCommonTool?.['_meta']).toMatchObject({
        [COMMON_SCHEMA_META_NAMESPACE]: {
          schemaHash: expectedSchemaHash,
        },
      });
      expect(
        (
          announcedBespokeTool?.['_meta'] as Record<string, unknown> | undefined
        )?.[COMMON_SCHEMA_META_NAMESPACE],
      ).toBeUndefined();

      expect(iTags).toEqual(
        expect.arrayContaining([['i', expectedSchemaHash, commonToolName]]),
      );
      expect(iTags.some((tag) => tag[2] === bespokeToolName)).toBe(false);
      expect(kTags).toEqual([['k', COMMON_SCHEMA_META_NAMESPACE]]);

      await client.close();
      await server.close();
      await relayPool.disconnect();
    },
    15000,
  );
});
