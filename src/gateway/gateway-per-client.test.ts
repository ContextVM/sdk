import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getPublicKey } from 'nostr-tools';
import { hexToBytes } from 'nostr-tools/utils';
import { TEST_PRIVATE_KEY } from '../__mocks__/fixtures.js';
import { createLogger } from '../core/utils/logger.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { NostrMCPGateway } from './index.js';
import { spawnMockRelay } from '../__mocks__/test-relay-helpers.js';

describe('NostrMCPGateway per-client MCP routing', () => {
  let stopRelay: (() => void) | undefined;
  let relayUrl: string;
  const logger = createLogger('gateway-per-client-test');

  const gatewayPrivateKey = TEST_PRIVATE_KEY;
  const gatewayPublicKey = getPublicKey(hexToBytes(gatewayPrivateKey));

  const client1PrivateKey = 'a'.repeat(64);
  const client2PrivateKey = 'b'.repeat(64);

  const createClientTransport = (
    clientPrivateKey: string,
  ): NostrClientTransport => {
    const clientSigner = new PrivateKeySigner(clientPrivateKey);
    const clientRelayHandler = new ApplesauceRelayPool([relayUrl]);

    return new NostrClientTransport({
      signer: clientSigner,
      relayHandler: clientRelayHandler,
      serverPubkey: gatewayPublicKey,
    });
  };

  const createGateway = async (options: {
    maxSessions: number;
  }): Promise<{
    gateway: NostrMCPGateway;
    getCreatedCount: () => number;
    getCloseByPubkey: () => Map<string, boolean>;
  }> => {
    const gatewaySigner = new PrivateKeySigner(gatewayPrivateKey);
    const gatewayRelayHandler = new ApplesauceRelayPool([relayUrl]);

    let createdCount = 0;
    const closeByPubkey = new Map<string, boolean>();

    const gateway = new NostrMCPGateway({
      createMcpClientTransport: ({ clientPubkey }) => {
        createdCount += 1;
        const transport = new StdioClientTransport({
          command: 'bun',
          args: ['src/__mocks__/mock-mcp-server.ts'],
          stderr: 'pipe',
        });

        const originalClose = transport.close.bind(transport);
        transport.close = async () => {
          closeByPubkey.set(clientPubkey, true);
          await originalClose();
        };

        return transport;
      },
      nostrTransportOptions: {
        signer: gatewaySigner,
        relayHandler: gatewayRelayHandler,
        isPublicServer: false,
        maxSessions: options.maxSessions,
        serverInfo: {
          name: 'Test Server',
          website: 'http://localhost',
        },
      },
    });

    await gateway.start();
    await sleep(100);
    logger.info('Gateway started', { gatewayPublicKey });

    return {
      gateway,
      getCreatedCount: () => createdCount,
      getCloseByPubkey: () => closeByPubkey,
    };
  };

  beforeAll(async () => {
    const relay = await spawnMockRelay();
    relayUrl = relay.relayUrl;
    stopRelay = relay.stop;

    logger.info('Relay started', { relayUrl });
  }, 20000);

  afterAll(async () => {
    stopRelay?.();
    await sleep(100);
  });

  test.serial(
    'should create a distinct MCP transport per client pubkey',
    async () => {
      const { gateway, getCreatedCount } = await createGateway({
        maxSessions: 10,
      });
      const client1 = new Client({ name: 'client-1', version: '1.0.0' });
      const client2 = new Client({ name: 'client-2', version: '1.0.0' });

      await client1.connect(createClientTransport(client1PrivateKey));
      await client2.connect(createClientTransport(client2PrivateKey));

      const tools1 = await client1.listTools();
      const tools2 = await client2.listTools();

      expect(tools1.tools.map((t) => t.name)).toContain('add');
      expect(tools2.tools.map((t) => t.name)).toContain('add');

      expect(getCreatedCount()).toBe(2);

      await client1.close();
      await client2.close();

      await gateway.stop();
    },
    20000,
  );

  test.serial(
    'should close per-client MCP transport when Nostr session is evicted',
    async () => {
      const { gateway, getCloseByPubkey } = await createGateway({
        maxSessions: 1,
      });
      const client1Pubkey = getPublicKey(hexToBytes(client1PrivateKey));

      const client1 = new Client({ name: 'evict-client-1', version: '1.0.0' });
      await client1.connect(createClientTransport(client1PrivateKey));
      await client1.listTools();

      const client2 = new Client({ name: 'evict-client-2', version: '1.0.0' });
      await client2.connect(createClientTransport(client2PrivateKey));
      await client2.listTools();

      // SessionStore eviction happens synchronously during insertion, but gateway cleanup is async.
      await sleep(250);

      expect(getCloseByPubkey().get(client1Pubkey)).toBe(true);

      await client1.close();
      await client2.close();

      await gateway.stop();
    },
    20000,
  );

  test.serial(
    'should recreate transport on client re-initialization',
    async () => {
      const { gateway, getCreatedCount } = await createGateway({
        maxSessions: 10,
      });

      const client1 = new Client({
        name: 'reconnect-client',
        version: '1.0.0',
      });

      // First connection and initialization.
      await client1.connect(createClientTransport(client1PrivateKey));
      const tools1 = await client1.listTools();
      expect(tools1.tools.map((t) => t.name)).toContain('add');

      // Get the initial transport creation count.
      const initialCreatedCount = getCreatedCount();

      // Close the connection.
      await client1.close();
      await sleep(100);

      // Reconnect the same client - should trigger a new transport creation
      // for the initialization request.
      const client1Reconnect = new Client({
        name: 'reconnect-client',
        version: '1.0.0',
      });
      await client1Reconnect.connect(createClientTransport(client1PrivateKey));
      const tools2 = await client1Reconnect.listTools();
      expect(tools2.tools.map((t) => t.name)).toContain('add');

      // Verify that a new transport was created for the re-initialization.
      expect(getCreatedCount()).toBe(initialCreatedCount + 1);

      await client1Reconnect.close();
      await gateway.stop();
    },
    20000,
  );
});
