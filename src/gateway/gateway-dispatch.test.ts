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
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { NostrMCPGateway } from './index.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

/**
 * Guards the single-client dispatch contract: `NostrServerTransport` fires both
 * `onmessage` and `onmessageWithContext` for client messages (the former is the
 * MCP Transport contract, the latter carries the Nostr pubkey). In single-client
 * mode the gateway must forward exactly once — via `onmessage` — otherwise every
 * request executes twice on the underlying MCP server. See the symmetric
 * early-returns in `NostrMCPGateway.setupEventHandlers`.
 */
describe.serial('NostrMCPGateway single-client dispatch', () => {
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

  test('forwards a request to the MCP server exactly once', async () => {
    let calls = 0;
    const mcpServer = new McpServer({
      name: 'dispatch-count-server',
      version: '1.0.0',
    });
    mcpServer.registerTool(
      'ping',
      {
        title: 'Ping',
        description: 'Counts how many times it runs',
        inputSchema: {},
      },
      async () => {
        calls++;
        return { content: [{ type: 'text' as const, text: 'pong' }] };
      },
    );
    const [mcpTransport, gatewayMcpTransport] =
      InMemoryTransport.createLinkedPair();
    await mcpServer.connect(mcpTransport);

    const gatewaySK = generateSecretKey();
    const gateway = new NostrMCPGateway({
      mcpClientTransport: gatewayMcpTransport,
      nostrTransportOptions: {
        signer: new PrivateKeySigner(bytesToHex(gatewaySK)),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
        publishRelayList: false,
      },
    });
    await gateway.start();

    const client = new Client({ name: 'dispatch-client', version: '1.0.0' });
    await client.connect(
      new NostrClientTransport({
        signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverPubkey: getPublicKey(gatewaySK),
        encryptionMode: EncryptionMode.DISABLED,
      }) as never,
    );

    await client.callTool({ name: 'ping', arguments: {} });

    // Let any duplicate dispatch settle before asserting; without the
    // single-client guard in `onmessageWithContext` this is 2.
    await sleep(50);
    expect(calls).toBe(1);

    await client.close();
    await gateway.stop();
    await mcpServer.close();
  }, 20000);
});
