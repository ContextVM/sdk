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
import { z } from 'zod';
import { bytesToHex } from 'nostr-tools/utils';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import {
  FakePaymentProcessor,
  withServerPayments,
  withClientPayments,
} from '../payments/index.js';
import { withServerRedirect, withClientRedirect } from '../redirect/index.js';
import { PAYMENT_REQUIRED_ERROR_CODE } from '../payments/constants.js';
import {
  spawnMockRelay,
  clearRelayCache,
} from '../__mocks__/test-relay-helpers.js';

/**
 * Exercises the full redirect × payments composition end-to-end.
 *
 * Wrapping order mirrors the production wiring in `NostrMCPProxy`:
 *   client-side:  redirect( payments( baseTransport ), wrapTransport = t => payments(t) )
 *   server-side:  payments( redirect( baseTransport ) )
 *
 * This validates that:
 *  - The initial server's redirect middleware fires BEFORE its payment gating.
 *  - The client transparently follows the redirect and re-establishes a session
 *    with the target server.
 *  - The target server's payment gating (-32042) is correctly surfaced through
 *    both the redirect and payment layers to the Client.
 */
describe.serial('Redirect and Payments Composition', () => {
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

  test('redirect short-circuits payment gating on initial server, and payment succeeds on target server', async () => {
    // 1. Target Server — prices `echo` at 1 'test' currency via `withServerPayments`.
    const targetSK = generateSecretKey();
    const targetServer = new McpServer({
      name: 'target-paid-server',
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
        content: [{ type: 'text', text: `Paid: ${message}` }],
      }),
    );
    const targetTransport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(bytesToHex(targetSK)),
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
    await targetServer.connect(targetTransport);
    const targetPubkey = getPublicKey(targetSK);

    // 2. Initial Server — redirects all requests to Target Server.
    //    Redirect middleware is wired BEFORE payments (correct server-side order)
    //    so the redirect fires before payment gating ever evaluates.
    const initialSK = generateSecretKey();
    const initialServer = new McpServer({
      name: 'initial-redirect-server',
      version: '1.0.0',
    });
    const initialTransportBase = new NostrServerTransport({
      signer: new PrivateKeySigner(bytesToHex(initialSK)),
      relayHandler: new ApplesauceRelayPool([relayUrl]),
      encryptionMode: EncryptionMode.DISABLED,
    });
    const initialTransportRedirect = withServerRedirect(initialTransportBase, {
      resolveRedirect: async () => ({
        target: targetPubkey,
        relays: [relayUrl],
      }),
    });
    // Even though the initial server has an expensive price, the redirect fires first
    const initialTransport = withServerPayments(initialTransportRedirect, {
      processors: [new FakePaymentProcessor()],
      pricedCapabilities: [
        {
          method: 'tools/call',
          name: 'echo',
          amount: 500, // Expensive — but redirect should fire before this evaluates
          currencyUnit: 'test',
        },
      ],
      paymentInteraction: 'optional',
    });
    await initialServer.connect(initialTransport);
    const initialPubkey = getPublicKey(initialSK);

    // 3. Client — mirrors the NostrMCPProxy wrapping pattern:
    //    payments(base) → redirect(paymentsWrapped, wrapTransport = t => payments(t))
    //
    //    This ensures the INITIAL transport is already wrapped in payments,
    //    and any NEW transport created after redirect is also wrapped in payments
    //    via `wrapTransport`.
    const clientSigner = new PrivateKeySigner(
      bytesToHex(generateSecretKey()),
    );
    const paymentOpts = { paymentInteraction: 'explicit_gating' as const };

    const baseClientTransport = withClientPayments(
      new NostrClientTransport({
        signer: clientSigner,
        relayHandler: new ApplesauceRelayPool([relayUrl]),
        serverPubkey: initialPubkey,
        encryptionMode: EncryptionMode.DISABLED,
      }),
      paymentOpts,
    );

    // Redirect wraps the payments-wrapped transport. On redirect, `wrapTransport`
    // re-applies payments to the newly spawned transport — matching the proxy.
    const clientTransport = withClientRedirect(
      baseClientTransport,
      {
        signer: clientSigner,
        encryptionMode: EncryptionMode.DISABLED,
        wrapTransport: (t) => withClientPayments(t, paymentOpts),
      },
      { maxRedirects: 2 },
    );

    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport as never);

    // Call the tool. The flow should be:
    //   Client → initial server → -32044 redirect → client follows → target server → -32042 payment required
    // The -32042 from the TARGET server (amount=1) proves that:
    //   a) The initial server's redirect fired (not its amount=500 payment gating)
    //   b) The client followed the redirect and re-established a session
    //   c) The target server's payment gating is correctly surfaced
    let caughtError: unknown;
    try {
      await client.callTool({ name: 'echo', arguments: { message: 'hello' } });
    } catch (err: unknown) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
    const mcpErr = caughtError as { code: number; data: unknown };
    expect(mcpErr.code).toBe(PAYMENT_REQUIRED_ERROR_CODE);

    // Verify the payment amount came from the TARGET server (1), not the initial server (500).
    // This is the key composition assertion: the redirect fired before the initial server's
    // expensive payment gating ever evaluated.
    const dataStr = JSON.stringify(mcpErr.data);
    expect(dataStr).toContain('"amount":1');
    expect(dataStr).not.toContain('"amount":500');

    await client.close();
    await targetServer.close();
    await initialServer.close();
  }, 20000);
});
