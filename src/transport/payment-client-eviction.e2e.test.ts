import { expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { EncryptionMode } from '../core/interfaces.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import {
  withClientPayments,
  withServerPayments,
  InMemoryPaymentStateStore,
  type PaymentProcessor,
} from '../payments/index.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';

test('many paying clients complete after session eviction and peer disconnects without re-execution', async () => {
  const hub = new MockRelayHub();
  const key = generateSecretKey();
  const state = new InMemoryPaymentStateStore();
  const clients: Client[] = [];
  let release!: () => void;
  const pendingSettlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  let invoices = 0;
  let approvals = 0;
  let executions = 0;
  const processor: PaymentProcessor = {
    pmi: 'fake',
    async createPaymentRequired(input) {
      return {
        amount: 1,
        pmi: 'fake',
        pay_req: `invoice-${input.requestEventId}-${++invoices}`,
        ttl: 10,
      };
    },
    async verifyPayment() {
      await pendingSettlement;
      return {};
    },
  };
  const server = new McpServer({ name: 'eviction-server', version: '1' });
  server.registerTool('paid', { inputSchema: {} }, async () => {
    executions++;
    return { content: [{ type: 'text', text: 'paid-result' }] };
  });
  const transport = withServerPayments(
    new NostrServerTransport({
      signer: new PrivateKeySigner(bytesToHex(key)),
      relayHandler: hub.createRelayHandler(),
      encryptionMode: EncryptionMode.REQUIRED,
      maxSessions: 2,
    }),
    {
      stateStore: state,
      processors: [processor],
      pricedCapabilities: [
        { method: 'tools/call', amount: 1, currencyUnit: 'test' },
      ],
    },
  );
  try {
    await server.connect(transport);
    for (let i = 0; i < 8; i++) {
      const client = new Client({ name: `paying-client-${i}`, version: '1' });
      await client.connect(
        withClientPayments(
          new NostrClientTransport({
            signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
            relayHandler: hub.createRelayHandler(),
            serverPubkey: getPublicKey(key),
            encryptionMode: EncryptionMode.REQUIRED,
          }),
          {
            handlers: [
              {
                pmi: 'fake',
                async handle() {
                  approvals++;
                },
              },
            ],
          },
        ),
      );
      clients.push(client);
    }
    const results = clients.map((client) =>
      client
        .callTool({ name: 'paid', arguments: {} }, undefined, { timeout: 5000 })
        .catch((error) => error),
    );
    const deadline = Date.now() + 3000;
    while (approvals < clients.length && Date.now() < deadline)
      await Bun.sleep(5);
    expect(approvals).toBe(clients.length);
    await clients[0]?.close();
    await clients[1]?.close();
    release();
    const completed = await Promise.all(results);
    expect(completed[0]).toBeInstanceOf(Error);
    expect(completed[1]).toBeInstanceOf(Error);
    for (const result of completed.slice(2))
      expect(result.content).toEqual([{ type: 'text', text: 'paid-result' }]);
    expect([invoices, approvals, executions]).toEqual([8, 8, 8]);
  } finally {
    release();
    await Promise.all(clients.map((client) => client.close()));
    await server.close();
    hub.clear();
  }
}, 10000);
