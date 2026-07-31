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
import { NostrMCPProxy } from './index.js';
import { FakePaymentProcessor, withServerPayments } from '../payments/index.js';
import { PAYMENT_REQUIRED_ERROR_CODE } from '../payments/constants.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

/**
 * Proves the proxy wires CEP-8 payments through `withClientPayments`. With
 * `paymentInteraction: 'explicit_gating'` and no in-band handler (the agent-host
 * path), a priced tool call surfaces a clean `-32042` JSON-RPC error carrying
 * `payment_options` to the host — instead of streaming an invoice no human can
 * pay. This is exactly the path that hung before the proxy wrapped its internal
 * transport.
 */
describe.serial('NostrMCPProxy payments wiring', () => {
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

  test('explicit_gating surfaces -32042 to the host for a priced tool', async () => {
    // Paid server: prices `echo`, accepts explicit_gating (`optional`).
    const serverSK = generateSecretKey();
    const mcpServer = new McpServer({
      name: 'proxy-paid-server',
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
    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(bytesToHex(serverSK)),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
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
    );
    await mcpServer.connect(serverTransport);
    const serverPublicKey = getPublicKey(serverSK);

    // Host side of an in-memory pair; the proxy relays MCP through it.
    const [hostTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();

    const proxy = new NostrMCPProxy({
      mcpHostTransport: hostTransport,
      nostrTransportOptions: {
        signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverPubkey: serverPublicKey,
        encryptionMode: EncryptionMode.DISABLED,
      },
      paymentOptions: { paymentInteraction: 'explicit_gating' },
    });
    await proxy.start();

    const client = new Client({ name: 'proxy-host-client', version: '1.0.0' });
    await client.connect(clientTransport);

    await expect(
      client.callTool({ name: 'echo', arguments: { message: 'hi' } }),
    ).rejects.toMatchObject({
      code: PAYMENT_REQUIRED_ERROR_CODE,
      data: { payment_options: expect.any(Array) },
    });

    await client.close();
    await proxy.stop();
    await mcpServer.close();
  }, 20000);
});
