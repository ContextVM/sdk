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
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { NostrMCPGateway } from './index.js';
import { withClientRedirect } from '../redirect/index.js';
import { withClientPayments } from '../payments/index.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

/**
 * Proves `NostrMCPGateway` correctly wires `redirectConfig` via
 * `withServerRedirect` on its internal server transport.
 *
 * Mirrors `gateway-payments.test.ts` but exercises the redirect path:
 * a gateway configured with `redirectConfig` should emit -32044 to
 * its Nostr clients, proving the middleware is wired and the high-level
 * `redirectConfig` option works end-to-end.
 */
describe.serial('NostrMCPGateway redirect wiring', () => {
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

  test('gateway follows a server redirect configured via redirectConfig', async () => {
    // Target Server — a real MCP server reachable over Nostr
    const targetSK = generateSecretKey();
    const targetServer = new McpServer({
      name: 'gateway-target-server',
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
        content: [{ type: 'text', text: `GW-Redirected: ${message}` }],
      }),
    );
    const targetTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(bytesToHex(targetSK)),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
    });
    await targetServer.connect(targetTransport);
    const targetPubkey = getPublicKey(targetSK);

    // Gateway — bridges a local MCP server and exposes it over Nostr.
    // `redirectConfig` injects the server-side redirect middleware so that
    // all inbound requests get redirected to the target server.
    const [mcpTransport, gatewayMcpTransport] =
      InMemoryTransport.createLinkedPair();
    const mcpServer = new McpServer({
      name: 'gateway-initial-server',
      version: '1.0.0',
    });
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
      redirectConfig: {
        resolveRedirect: async () => ({
          target: targetPubkey,
          relays: [relayUrl],
        }),
      },
    });
    await gateway.start();
    const gatewayPubkey = getPublicKey(gatewaySK);

    // Client — connects to the gateway over Nostr with redirect support.
    // Mirrors the `NostrMCPProxy` wrapping order: payments(base) → redirect(…)
    const clientSigner = new PrivateKeySigner(
      bytesToHex(generateSecretKey()),
    );
    const baseClientTransport = withClientPayments(
      new NostrClientTransport({
        signer: clientSigner,
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverPubkey: gatewayPubkey,
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {},
    );
    const clientTransport = withClientRedirect(
      baseClientTransport,
      {
        signer: clientSigner,
        encryptionMode: EncryptionMode.DISABLED,
        wrapTransport: (t) => withClientPayments(t, {}),
      },
      { maxRedirects: 2 },
    );

    const client = new Client({
      name: 'gateway-redirect-client',
      version: '1.0.0',
    });
    await client.connect(clientTransport as never);

    const res = await client.callTool({
      name: 'echo',
      arguments: { message: 'hello gateway' },
    });
    expect((res.content as Array<{ text: string }>)[0].text).toBe(
      'GW-Redirected: hello gateway',
    );

    await client.close();
    await gateway.stop();
    await targetServer.close();
  }, 20000);
});
