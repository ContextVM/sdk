import { describe, expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { z } from 'zod';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { withClientPayments, withServerPayments } from '../payments/index.js';
import type { PaymentProcessor } from '../payments/types.js';

const cases = [
  {
    name: 'cleartext',
    encryptionMode: EncryptionMode.DISABLED,
    giftWrapMode: GiftWrapMode.OPTIONAL,
    kind: 25910,
  },
  {
    name: 'persistent encryption',
    encryptionMode: EncryptionMode.REQUIRED,
    giftWrapMode: GiftWrapMode.PERSISTENT,
    kind: 1059,
  },
  {
    name: 'ephemeral encryption',
    encryptionMode: EncryptionMode.REQUIRED,
    giftWrapMode: GiftWrapMode.EPHEMERAL,
    kind: 21059,
  },
];

describe('instant explicit payment retry delivery', () => {
  for (const mode of cases) {
    test(`instant payment executes once over ${mode.name} without callback sleeps`, async () => {
      const hub = new MockRelayHub();
      const serverKey = generateSecretKey();
      const clientSigner = new PrivateKeySigner(
        bytesToHex(generateSecretKey()),
      );
      const requests: Array<{ id: string; createdAt: number }> = [];
      const sign = clientSigner.signEvent.bind(clientSigner);
      clientSigner.signEvent = async (event) => {
        const signed = await sign(event);
        if (
          event.kind === 25910 &&
          JSON.parse(event.content).method === 'tools/call'
        ) {
          requests.push({ id: signed.id, createdAt: event.created_at });
        }
        return signed;
      };
      let executions = 0;
      let invoices = 0;
      let approvals = 0;
      const processor: PaymentProcessor = {
        pmi: 'fake',
        async createPaymentRequired(params) {
          invoices++;
          return {
            amount: params.amount,
            pmi: 'fake',
            pay_req: `invoice-${invoices}`,
            ttl: 60,
          };
        },
        async verifyPayment() {
          return {};
        },
      };
      const server = new McpServer({
        name: 'payment-retry-server',
        version: '1.0.0',
      });
      server.registerTool(
        'paid',
        { inputSchema: { value: z.number() } },
        async ({ value }) => {
          executions++;
          return { content: [{ type: 'text', text: String(value) }] };
        },
      );
      const serverTransport = withServerPayments(
        new NostrServerTransport({
          signer: new PrivateKeySigner(bytesToHex(serverKey)),
          relayHandler: hub.createRelayHandler(),
          encryptionMode: mode.encryptionMode,
          giftWrapMode: mode.giftWrapMode,
        }),
        {
          processors: [processor],
          pricedCapabilities: [
            {
              method: 'tools/call',
              name: 'paid',
              amount: 5,
              currencyUnit: 'sats',
            },
          ],
        },
      );
      const base = new NostrClientTransport({
        signer: clientSigner,
        relayHandler: hub.createRelayHandler(),
        serverPubkey: getPublicKey(serverKey),
        encryptionMode: mode.encryptionMode,
        giftWrapMode: mode.giftWrapMode,
      });
      const paid = withClientPayments(base, {
        paymentInteraction: 'explicit_gating',
        minRetryDelayMs: 0,
        async onPaymentRequired() {
          approvals++;
          return { paid: true };
        },
      });
      const client = new Client({
        name: 'payment-retry-client',
        version: '1.0.0',
      });
      try {
        await server.connect(serverTransport);
        await client.connect(paid);
        // Initialization finishes negotiation, so routine invocations have stable tags.
        const result = await client.callTool(
          { name: 'paid', arguments: { value: 7 } },
          undefined,
          { timeout: 5000 },
        );
        expect(result.content).toEqual([{ type: 'text', text: '7' }]);
        expect(approvals).toBe(1);
        expect(invoices).toBe(1);
        expect(executions).toBe(1);
        expect(requests).toHaveLength(2);
        expect(requests[1]!.id).not.toBe(requests[0]!.id);
        expect(requests[1]!.createdAt).toBeGreaterThan(requests[0]!.createdAt);
        expect(hub.getEvents().some((event) => event.kind === mode.kind)).toBe(
          true,
        );
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
