import { expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { z } from 'zod';
import type { NostrEvent } from 'nostr-tools';
import { withTimeout } from '../core/utils/utils.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { withClientPayments, withServerPayments } from '../payments/index.js';
import { InMemoryPaymentStateStore } from '../payments/in-memory-payment-state-store.js';
import { canonicalJson } from '../core/utils/canonical-json.js';
import type {
  PaymentProcessor,
  PaymentStateRecord,
  PaymentStateStore,
} from '../payments/index.js';

const modes = [
  {
    name: 'cleartext',
    encryptionMode: EncryptionMode.DISABLED,
    giftWrapMode: GiftWrapMode.OPTIONAL,
  },
  {
    name: 'persistent encryption',
    encryptionMode: EncryptionMode.REQUIRED,
    giftWrapMode: GiftWrapMode.PERSISTENT,
  },
  {
    name: 'ephemeral encryption',
    encryptionMode: EncryptionMode.REQUIRED,
    giftWrapMode: GiftWrapMode.EPHEMERAL,
  },
];

for (const mode of modes)
  for (const failResult of [
    false,
    'ordinary',
    'start',
    'chunk',
    'end',
    'result_ack',
    'publication_ack',
  ] as const)
    test(`injected payment store: two transports, failure=${failResult}, recreation/replay over ${mode.name}`, async () => {
      const oversized =
        failResult === 'start' ||
        failResult === 'chunk' ||
        failResult === 'end';
      const expectedText = oversized ? '7'.repeat(4000) : '7';
      // Application-owned memory survives transport recreation, not process restart.
      const backend = new InMemoryPaymentStateStore();
      const hub = new MockRelayHub();
      const serverKey = generateSecretKey();
      const clientKey = generateSecretKey();
      const clientPubkey = getPublicKey(clientKey);
      let invoices = 0;
      let approvals = 0;
      let verifications = 0;
      let executions = 0;
      let terminalPublications = 0;
      let failedResult = false;
      let admittedRecord: PaymentStateRecord | undefined;
      const processor: PaymentProcessor = {
        pmi: 'fake',
        currencyUnit: 'sats',
        async createPaymentRequired(input) {
          invoices++;
          return {
            amount: input.amount,
            pmi: 'fake',
            pay_req: `invoice-${invoices}`,
            ttl: 2,
          };
        },
        async verifyPayment() {
          verifications++;
          return {};
        },
      };
      const servers: McpServer[] = [];
      const createTransport = async (
        onReplay?: () => void,
      ): Promise<NostrServerTransport> => {
        // Exercise the public interface without requiring the bundled implementation's class.
        const store: PaymentStateStore = {
          policy: backend.policy,
          admit: async (input) => {
            const result = await backend.admit(input);
            if (result.status === 'reserved') admittedRecord = result.record;
            if (result.status === 'duplicate') onReplay?.();
            return result;
          },
          transition: async (input) => {
            const changed = await backend.transition(input);
            if (
              changed &&
              !failedResult &&
              ((failResult === 'result_ack' && input.type === 'result') ||
                (failResult === 'publication_ack' &&
                  input.type === 'published'))
            ) {
              failedResult = true;
              throw new Error(
                'Injected storage acknowledgement loss after commit',
              );
            }
            return changed;
          },
          read: async (key) => {
            const record = await backend.read(key);
            // An external backend may serialize and reorder JSON properties.
            return record && JSON.parse(canonicalJson(record));
          },
        };
        const server = new McpServer({
          name: 'payment-store-transport',
          version: '1.0.0',
        });
        server.registerTool(
          'paid',
          { inputSchema: { value: z.number() } },
          async ({ value }) => {
            executions++;
            return {
              content: [
                {
                  type: 'text',
                  text: oversized ? String(value).repeat(4000) : String(value),
                },
              ],
            };
          },
        );
        servers.push(server);
        const serverRelay = hub.createRelayHandler();
        const transport = withServerPayments(
          new NostrServerTransport({
            signer: new PrivateKeySigner(bytesToHex(serverKey)),
            relayHandler: serverRelay,
            encryptionMode: mode.encryptionMode,
            giftWrapMode: mode.giftWrapMode,
            oversizedTransfer: {
              enabled: oversized,
              thresholdBytes: 4000,
              chunkSizeBytes: 1000,
            },
          }),
          {
            stateStore: store,
            paymentTtlMs: 2000,
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
        const router = transport['outboundResponseRouter'];
        const publishResponse = router['deps'].sendMcpMessage;
        router['deps'].sendMcpMessage = async (message, ...args) => {
          const frameType =
            'method' in message
              ? (message.params?.cvm as { frameType?: string } | undefined)
                  ?.frameType
              : 'ordinary';
          const isPaidResponse = args[2]?.some(
            (tag) =>
              tag[0] === 'e' && tag[1] === admittedRecord?.requestEventId,
          );
          if (
            failResult &&
            !failedResult &&
            isPaidResponse &&
            frameType === failResult
          ) {
            failedResult = true;
            throw new Error(
              `Injected ${failResult} result publication failure`,
            );
          }
          const sent = await publishResponse(message, ...args);
          if (
            isPaidResponse &&
            (frameType === 'end' || frameType === 'ordinary')
          )
            terminalPublications++;
          return sent;
        };
        await server.connect(transport);
        return transport;
      };
      const clientEvents: NostrEvent[] = [];
      const clientRelay = hub.createRelayHandler();
      const publish = clientRelay.publish.bind(clientRelay);
      clientRelay.publish = async (event, options) => {
        clientEvents.push(event);
        await publish(event, options);
      };
      const client = new Client({
        name: 'payment-store-client',
        version: '1.0.0',
      });
      try {
        await createTransport();
        await createTransport();
        const base = new NostrClientTransport({
          signer: new PrivateKeySigner(bytesToHex(clientKey)),
          relayHandler: clientRelay,
          serverPubkey: getPublicKey(serverKey),
          encryptionMode: mode.encryptionMode,
          giftWrapMode: mode.giftWrapMode,
          oversizedTransfer: {
            enabled: oversized,
            thresholdBytes: 4000,
            chunkSizeBytes: 1000,
          },
        });
        await client.connect(
          withClientPayments(base, {
            handlers: [
              {
                pmi: 'fake',
                async handle() {
                  approvals++;
                },
              },
            ],
          }),
        );
        const resultPromise = client.callTool(
          { name: 'paid', arguments: { value: 7 } },
          undefined,
          { timeout: 20000, ...(oversized && { onprogress: () => {} }) },
        );
        void resultPromise.catch(() => {});
        if (failResult) {
          const deadline = Date.now() + 10000;
          const expectedStatus =
            failResult === 'result_ack'
              ? 'pending'
              : failResult === 'publication_ack'
                ? 'published'
                : 'unknown';
          let retained: PaymentStateRecord | undefined;
          while (Date.now() < deadline) {
            if (admittedRecord)
              retained = await backend.read(admittedRecord.key);
            if (failedResult && retained?.delivery?.status === expectedStatus)
              break;
            await Bun.sleep(5);
          }
          expect(retained?.delivery?.status).toBe(expectedStatus);
          expect(failedResult).toBe(true);
          await Promise.all(servers.splice(0).map((server) => server.close()));
          const recoveredTransport = await createTransport();
          await recoveredTransport.retryPaymentResult(
            clientPubkey,
            admittedRecord!.requestEventId,
          );
        }
        const result = await resultPromise;
        expect(result.content).toEqual([{ type: 'text', text: expectedText }]);
        expect([invoices, approvals, verifications, executions]).toEqual([
          1, 1, 1, 1,
        ]);
        expect(admittedRecord?.clientPubkey).toBe(clientPubkey);
        const publicationDeadline = Date.now() + 10000;
        while (
          (await backend.read(admittedRecord!.key))?.delivery?.status !==
            'published' &&
          Date.now() < publicationDeadline
        )
          await Bun.sleep(5);
        expect(
          (await backend.read(admittedRecord!.key))?.delivery?.status,
        ).toBe('published');
        expect(terminalPublications).toBe(1);
        await Promise.all(servers.splice(0).map((server) => server.close()));
        await Bun.sleep(
          Math.max(0, admittedRecord!.leaseExpiresAtMs - Date.now() + 25),
        );
        let replayed!: () => void;
        const replay = new Promise<void>((resolve) => {
          replayed = resolve;
        });
        const restartedTransport = await createTransport(replayed);
        // Deliver a relay replay directly into the real verification/decryption pipeline,
        // independently of the new subscription's narrower `since` filter.
        for (const event of clientEvents)
          await restartedTransport['processIncomingEvent'](event);
        await withTimeout(replay, 3000, 'Retained request was not replayed');
        expect([invoices, approvals, verifications, executions]).toEqual([
          1, 1, 1, 1,
        ]);
      } finally {
        await client.close();
        await Promise.all(servers.map((server) => server.close()));
        hub.clear();
      }
    });
