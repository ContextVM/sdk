import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { sleep } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import {
  FakePaymentHandler,
  FakePaymentProcessor,
  withClientPayments,
  withServerPayments,
} from '../payments/index.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

type PaidClient = {
  client: Client;
  transport: NostrClientTransport;
  close: () => Promise<void>;
};

async function createPaidClient(params: {
  relayUrl: string;
  serverPubkey: string;
  shouldHandlePayment: boolean;
}): Promise<PaidClient> {
  const clientSK = generateSecretKey();
  const clientPrivateKey = bytesToHex(clientSK);

  const transport = new NostrClientTransport({
    signer: new PrivateKeySigner(clientPrivateKey),
    relayHandler: new ApplesauceRelayPool([params.relayUrl]),
    serverPubkey: params.serverPubkey,
    encryptionMode: EncryptionMode.DISABLED,
  });

  const paidTransport = withClientPayments(transport, {
    handlers: params.shouldHandlePayment
      ? [new FakePaymentHandler({ delayMs: 30 })]
      : [],
  });

  const client = new Client({ name: 'paid-client', version: '1.0.0' });
  await client.connect(paidTransport);

  return {
    client,
    transport,
    close: async () => {
      try {
        await client.close();
      } catch (error) {
        // In this test we intentionally simulate mid-flight disconnects.
        // The MCP SDK can surface that as an error during close.
        const msg = error instanceof Error ? error.message : String(error);
        if (!/connection closed/i.test(msg)) {
          throw error;
        }
      }
    },
  };
}

describe('payments real-world regression (server + many clients)', () => {
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

  test('many clients, some disconnect mid-flight; server remains responsive (no zombie publish loops)', async () => {
    const serverSK = generateSecretKey();
    const serverPrivateKey = bytesToHex(serverSK);
    const serverPublicKey = getPublicKey(serverSK);

    const mcpServer = new McpServer({
      name: 'paid-server-multi-client',
      version: '1.0.0',
    });

    mcpServer.registerTool(
      'add',
      {
        title: 'Addition Tool',
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }: { a: number; b: number }) => ({
        content: [{ type: 'text', text: String(a + b) }],
      }),
    );

    // Configure a priced tool; fake processor verifies quickly.
    const processor = new FakePaymentProcessor({ verifyDelayMs: 60 });
    const serverTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(serverPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        encryptionMode: EncryptionMode.DISABLED,
      }),
      {
        processors: [processor],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'add',
            amount: 1,
            currencyUnit: 'test',
            description: 'test payment',
          },
        ],
      },
    );

    await mcpServer.connect(serverTransport);

    // Create a batch of clients.
    const clients = await Promise.all([
      createPaidClient({
        relayUrl,
        serverPubkey: serverPublicKey,
        shouldHandlePayment: true,
      }),
      createPaidClient({
        relayUrl,
        serverPubkey: serverPublicKey,
        shouldHandlePayment: true,
      }),
      // A "bad" client that will disconnect while payment flow is in-flight.
      createPaidClient({
        relayUrl,
        serverPubkey: serverPublicKey,
        shouldHandlePayment: true,
      }),
    ]);

    const [clientA, clientB, clientC] = clients;

    // Start 3 concurrent priced calls.
    const aPromise = clientA.client.callTool({
      name: 'add',
      arguments: { a: 1, b: 2 },
    });
    const bPromise = clientB.client.callTool({
      name: 'add',
      arguments: { a: 3, b: 4 },
    });
    const cPromise = clientC.client.callTool({
      name: 'add',
      arguments: { a: 5, b: 6 },
    });

    // Attach rejection handling immediately so an early disconnect doesn't
    // surface as an unhandled rejection.
    const cSettledPromise = cPromise.then(
      () => ({ ok: true as const }),
      () => ({ ok: false as const }),
    );

    // Disconnect clientC quickly to simulate real-world drop.
    await sleep(25);
    await clientC.close();

    // The other two should still succeed.
    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect((a as { content: Array<{ text?: string }> }).content[0]?.text).toBe(
      '3',
    );
    expect((b as { content: Array<{ text?: string }> }).content[0]?.text).toBe(
      '7',
    );

    // The disconnected client's call should either reject or hang; ensure it resolves promptly.
    await expect(
      Promise.race([
        cSettledPromise,
        sleep(2000).then(() => ({ ok: false as const })),
      ]),
    ).resolves.toEqual({ ok: false });

    // If zombie publish loops were created, the server could become sluggish.
    // Make another request after churn to assert ongoing responsiveness.
    const again = await clientA.client.callTool({
      name: 'add',
      arguments: { a: 10, b: 20 },
    });
    expect(
      (again as { content: Array<{ text?: string }> }).content[0]?.text,
    ).toBe('30');

    await clientA.close();
    await clientB.close();
    await mcpServer.close();
  }, 30_000);
});
