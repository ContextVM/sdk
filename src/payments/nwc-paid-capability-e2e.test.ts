import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { sleep, type Subprocess } from 'bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { NostrServerTransport } from '../transport/nostr-server-transport.js';
import { CTXVM_MESSAGES_KIND } from '../core/index.js';
import type { NostrEvent } from 'nostr-tools';
import { withClientPayments, withServerPayments } from './index.js';
import { LnBolt11NwcPaymentHandler } from './handlers/ln-bolt11-nwc-payment-handler.js';
import { LnBolt11NwcPaymentProcessor } from './processors/ln-bolt11-nwc-payment-processor.js';

const nwcEnabled = process.env.NWC_INTEGRATION === 'true';

function isPaymentRequiredEvent(event: NostrEvent): boolean {
  try {
    const parsed = JSON.parse(event.content) as {
      method?: unknown;
      params?: unknown;
    };
    if (parsed.method !== 'notifications/payment_required') return false;
    if (typeof parsed.params !== 'object' || parsed.params === null)
      return false;
    return true;
  } catch {
    return false;
  }
}

async function captureNextPaymentRequired(params: {
  relayUrl: string;
  authors: string[];
  timeoutMs?: number;
}): Promise<{ event: NostrEvent; amount: number }> {
  const relayPool = new ApplesauceRelayPool([params.relayUrl]);
  await relayPool.connect();

  const timeoutMs = params.timeoutMs ?? 20_000;
  const event = await new Promise<NostrEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for payment_required'));
    }, timeoutMs);

    void relayPool.subscribe(
      [{ kinds: [CTXVM_MESSAGES_KIND], authors: params.authors }],
      (evt) => {
        if (isPaymentRequiredEvent(evt)) {
          clearTimeout(timeout);
          resolve(evt);
        }
      },
    );
  });

  const parsed = JSON.parse(event.content) as {
    params: { amount: number };
  };

  return { event, amount: parsed.params.amount };
}

describe('nwc paid capability e2e (skipped by default)', () => {
  const baseRelayPort = 7820;
  const relayUrl = `ws://localhost:${baseRelayPort}`;

  let relayProcess: Subprocess;

  beforeAll(async () => {
    relayProcess = Bun.spawn(['bun', 'src/__mocks__/mock-relay.ts'], {
      env: {
        ...process.env,
        PORT: `${baseRelayPort}`,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await sleep(100);
  });

  afterEach(async () => {
    try {
      const clearUrl = relayUrl.replace('ws://', 'http://') + '/clear-cache';
      await fetch(clearUrl, { method: 'POST' });
    } catch {
      // best-effort
    }
  });

  afterAll(async () => {
    relayProcess?.kill();
    await sleep(100);
  });

  test.skipIf(!nwcEnabled)(
    'client can call a priced tool and payments are handled via NWC',
    async () => {
      const serverConn = process.env.NWC_SERVER_CONNECTION;
      const clientConn = process.env.NWC_CLIENT_CONNECTION;

      if (!serverConn || !clientConn) {
        throw new Error(
          'Set NWC_SERVER_CONNECTION and NWC_CLIENT_CONNECTION when NWC_INTEGRATION=true',
        );
      }

      const serverSK = generateSecretKey();
      const serverPrivateKey = bytesToHex(serverSK);
      const serverPublicKey = getPublicKey(serverSK);

      const mcpServer = new McpServer({
        name: 'paid-server-nwc',
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

      const processor = new LnBolt11NwcPaymentProcessor({
        nwcConnectionString: serverConn,
        ttlSeconds: 120,
        pollIntervalMs: 1500,
      });

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
              currencyUnit: 'sats',
              description: 'ctxvm nwc e2e test',
            },
          ],
        },
      );

      await mcpServer.connect(serverTransport);

      const clientSK = generateSecretKey();
      const clientPrivateKey = bytesToHex(clientSK);

      const handlers = [
        new LnBolt11NwcPaymentHandler({
          nwcConnectionString: clientConn,
        }),
      ];

      const clientTransport = new NostrClientTransport({
        signer: new PrivateKeySigner(clientPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverPubkey: serverPublicKey,
        encryptionMode: EncryptionMode.DISABLED,
      });

      const paidClientTransport = withClientPayments(clientTransport, {
        handlers,
      });

      const client = new Client({ name: 'paid-client-nwc', version: '1.0.0' });
      await client.connect(paidClientTransport);

      const result = await client.callTool({
        name: 'add',
        arguments: { a: 1, b: 2 },
      });

      const typedResult = result as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(typedResult.content[0]).toMatchObject({ type: 'text', text: '3' });

      await client.close();
      await mcpServer.close();
    },
    120_000,
  );

  test.skipIf(!nwcEnabled)(
    'supports resolvePrice in a real NWC flow (amount reflected in payment_required)',
    async () => {
      const serverConn = process.env.NWC_SERVER_CONNECTION;
      const clientConn = process.env.NWC_CLIENT_CONNECTION;

      if (!serverConn || !clientConn) {
        throw new Error(
          'Set NWC_SERVER_CONNECTION and NWC_CLIENT_CONNECTION when NWC_INTEGRATION=true',
        );
      }

      const serverSK = generateSecretKey();
      const serverPrivateKey = bytesToHex(serverSK);
      const serverPublicKey = getPublicKey(serverSK);

      const mcpServer = new McpServer({
        name: 'paid-server-nwc-resolve-price',
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

      const processor = new LnBolt11NwcPaymentProcessor({
        nwcConnectionString: serverConn,
        ttlSeconds: 120,
        pollIntervalMs: 1500,
      });

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
              currencyUnit: 'sats',
              description: 'base price (should be overridden by resolvePrice)',
            },
          ],
          resolvePrice: async ({ request }) => {
            const params = request.params as
              | { arguments?: unknown }
              | undefined;
            const args = params?.arguments as
              | { a?: number; b?: number }
              | undefined;
            const a = typeof args?.a === 'number' ? args.a : 0;
            const b = typeof args?.b === 'number' ? args.b : 0;

            // Simple: charge 2 sats when sum is 3.
            return { amount: a + b === 3 ? 2 : 1 };
          },
        },
      );

      await mcpServer.connect(serverTransport);

      const clientSK = generateSecretKey();
      const clientPrivateKey = bytesToHex(clientSK);

      const handlers = [
        new LnBolt11NwcPaymentHandler({
          nwcConnectionString: clientConn,
        }),
      ];

      const clientTransport = new NostrClientTransport({
        signer: new PrivateKeySigner(clientPrivateKey),
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverPubkey: serverPublicKey,
        encryptionMode: EncryptionMode.DISABLED,
      });

      const paidClientTransport = withClientPayments(clientTransport, {
        handlers,
      });

      const paymentRequiredPromise = captureNextPaymentRequired({
        relayUrl,
        authors: [serverPublicKey],
        timeoutMs: 30_000,
      });

      const client = new Client({ name: 'paid-client-nwc', version: '1.0.0' });
      await client.connect(paidClientTransport);

      const resultPromise = client.callTool({
        name: 'add',
        arguments: { a: 1, b: 2 },
      });

      const [{ amount: observedAmount }, result] = await Promise.all([
        paymentRequiredPromise,
        resultPromise,
      ]);

      expect(observedAmount).toBe(2);

      const typedResult = result as {
        content: Array<{ type: string; text?: string }>;
      };
      expect(typedResult.content[0]).toMatchObject({ type: 'text', text: '3' });

      await client.close();
      await mcpServer.close();
    },
    120_000,
  );
});
