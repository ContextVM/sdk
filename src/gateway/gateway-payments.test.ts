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
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { NostrMCPGateway } from './index.js';
import { FakePaymentProcessor, withClientPayments } from '../payments/index.js';
import { PAYMENT_REQUIRED_ERROR_CODE } from '../payments/constants.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

/**
 * Proves `NostrMCPGateway` forwards `paymentOptions` to its internal server
 * transport via `withServerPayments`. With a priced `echo` tool and an
 * `optional` interaction policy, a client using `explicit_gating` gets a clean
 * `-32042` error (carrying `payment_options`) instead of the request hanging —
 * exactly the path that failed before the gateway wrapped its transport.
 */
describe.serial('NostrMCPGateway payments wiring', () => {
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

  test('explicit_gating surfaces -32042 through the gateway for a priced tool', async () => {
    // Paid MCP server bridged by the gateway. `echo` is priced.
    const mcpServer = new McpServer({
      name: 'gateway-paid-server',
      version: '1.0.0',
    });
    mcpServer.registerTool(
      'echo',
      {
        title: 'Echo',
        description: 'Echoes the message',
        inputSchema: { message: z.string() },
      },
      async ({ message }: { message: string }) => ({
        content: [{ type: 'text', text: message }],
      }),
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
      paymentOptions: {
        processors: [new FakePaymentProcessor()],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'echo',
            amount: 1,
            currencyUnit: 'test',
          },
        ],
        paymentInteraction: 'optional',
      },
    });
    await gateway.start();
    const gatewayPublicKey = getPublicKey(gatewaySK);

    // Client connects to the gateway over Nostr and requests explicit gating,
    // so the server (optional policy) returns a clean -32042 instead of the
    // transparent invoice-notification flow.
    const client = new Client({ name: 'gateway-client', version: '1.0.0' });
    await client.connect(
      withClientPayments(
        new NostrClientTransport({
          signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
          relayHandler: new ApplesauceRelayPool([relayUrl]),
          serverPubkey: gatewayPublicKey,
          encryptionMode: EncryptionMode.DISABLED,
        }),
        { paymentInteraction: 'explicit_gating' },
      ) as never,
    );

    await expect(
      client.callTool({ name: 'echo', arguments: { message: 'hi' } }),
    ).rejects.toMatchObject({
      code: PAYMENT_REQUIRED_ERROR_CODE,
      data: { payment_options: expect.any(Array) },
    });

    await client.close();
    await gateway.stop();
    await mcpServer.close();
  }, 20000);
});
