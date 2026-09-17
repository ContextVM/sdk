import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { z } from 'zod';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { EncryptionMode } from '../core/interfaces.js';
import { waitFor } from '../core/utils/test.utils.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { NostrServerTransport } from '../transport/nostr-server-transport.js';
import { AuthorizationStore } from './authorization-store.js';
import {
  PAYMENT_ACCEPTED_METHOD,
  PAYMENT_REQUIRED_ERROR_CODE,
} from './constants.js';
import { withServerPayments } from './server-transport-payments.js';
import type {
  PaymentProcessor,
  PaymentProcessorVerifyParams,
} from './types.js';

const PMI = 'pmi:controlled';

/**
 * Processor whose verification never settles on its own. The test decides
 * when it resolves and can inspect the abort signal the middleware passed in.
 * With `rejectOnAbort` it behaves like the built-in processors (the poll ends
 * as soon as the signal fires); without it, it ignores the signal so a verify
 * that lands after `close()` is exercised.
 */
function createControlledProcessor(options: { rejectOnAbort: boolean }): {
  processor: PaymentProcessor;
  verifyStarted: Promise<PaymentProcessorVerifyParams>;
  settle: () => void;
  outcomes: Array<'settled' | 'rejected'>;
} {
  let onVerifyStarted!: (params: PaymentProcessorVerifyParams) => void;
  const verifyStarted = new Promise<PaymentProcessorVerifyParams>((resolve) => {
    onVerifyStarted = resolve;
  });
  let settle: () => void = () => {};
  const outcomes: Array<'settled' | 'rejected'> = [];

  const processor: PaymentProcessor = {
    pmi: PMI,
    async createPaymentRequired(params) {
      return {
        amount: params.amount,
        pay_req: `controlled:${params.requestEventId}`,
        pmi: PMI,
      };
    },
    verifyPayment(params) {
      onVerifyStarted(params);
      return new Promise<{ _meta?: Record<string, unknown> }>(
        (resolve, reject) => {
          settle = () => resolve({ _meta: { settled: true } });
          if (options.rejectOnAbort) {
            params.abortSignal?.addEventListener(
              'abort',
              () => reject(new Error('verifyPayment aborted')),
              { once: true },
            );
          }
        },
      ).then(
        (value) => {
          outcomes.push('settled');
          return value;
        },
        (err: unknown) => {
          outcomes.push('rejected');
          throw err;
        },
      );
    },
  };

  return { processor, verifyStarted, settle: () => settle(), outcomes };
}

async function startPaidServer(processor: PaymentProcessor): Promise<{
  hub: MockRelayHub;
  serverPubkey: string;
  serverTransport: NostrServerTransport;
  toolCalls: unknown[];
}> {
  const hub = new MockRelayHub();
  const serverSk = generateSecretKey();
  const toolCalls: unknown[] = [];

  const mcpServer = new McpServer({
    name: 'shutdown-server',
    version: '1.0.0',
  });
  mcpServer.registerTool(
    'add',
    { inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => {
      toolCalls.push({ a, b });
      return { content: [{ type: 'text', text: String(a + b) }] };
    },
  );

  const serverTransport = new NostrServerTransport({
    signer: new PrivateKeySigner(bytesToHex(serverSk)),
    relayHandler: hub.createRelayHandler(),
    encryptionMode: EncryptionMode.DISABLED,
  });
  withServerPayments(serverTransport, {
    processors: [processor],
    pricedCapabilities: [
      { method: 'tools/call', name: 'add', amount: 21, currencyUnit: 'sats' },
    ],
  });
  await mcpServer.connect(serverTransport);

  return {
    hub,
    serverPubkey: getPublicKey(serverSk),
    serverTransport,
    toolCalls,
  };
}

async function connectClient(params: {
  hub: MockRelayHub;
  serverPubkey: string;
  explicitGating?: boolean;
}): Promise<Client> {
  const clientTransport = new NostrClientTransport({
    signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
    relayHandler: params.hub.createRelayHandler(),
    serverPubkey: params.serverPubkey,
    encryptionMode: EncryptionMode.DISABLED,
  });
  clientTransport.setClientPmis([PMI]);
  if (params.explicitGating) {
    clientTransport.setPaymentInteraction('explicit_gating');
  }
  const client = new Client({ name: 'shutdown-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

function paymentAcceptedEvents(hub: MockRelayHub, serverPubkey: string) {
  return hub
    .getEvents()
    .filter(
      (event) =>
        event.pubkey === serverPubkey &&
        event.content.includes(PAYMENT_ACCEPTED_METHOD),
    );
}

describe('withServerPayments shutdown cancels in-flight verification', () => {
  // Tests may run concurrently (CI passes --concurrent), so each owns its own
  // cleanup via try/finally instead of a shared afterEach list.
  const unhandled: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeAll(() => {
    process.on('unhandledRejection', onRejection);
  });

  afterAll(() => {
    process.off('unhandledRejection', onRejection);
    expect(unhandled).toEqual([]);
  });

  test('transparent: close() aborts the verify signal and a late settle neither forwards nor publishes payment_accepted', async () => {
    const { processor, verifyStarted, settle } = createControlledProcessor({
      rejectOnAbort: false,
    });
    const { hub, serverPubkey, serverTransport, toolCalls } =
      await startPaidServer(processor);
    const client = await connectClient({ hub, serverPubkey });

    // Never resolves while the payment is pending; client.close() rejects it.
    const call = client
      .callTool({ name: 'add', arguments: { a: 1, b: 2 } })
      .catch(() => undefined);
    try {
      const verifyParams = await verifyStarted;
      expect(serverTransport.closeSignal.aborted).toBe(false);
      expect(verifyParams.abortSignal?.aborted).toBe(false);

      await serverTransport.close();

      // Transport-owned signal fired and reached the per-request controller.
      expect(serverTransport.closeSignal.aborted).toBe(true);
      expect(verifyParams.abortSignal?.aborted).toBe(true);

      // Processor ignores the abort and reports success after shutdown.
      settle();
      await Bun.sleep(100);

      expect(toolCalls).toHaveLength(0);
      expect(paymentAcceptedEvents(hub, serverPubkey)).toHaveLength(0);
    } finally {
      await client.close();
      await call;
    }
  }, 20_000);

  test('transparent: a processor that honors the signal stops polling right after close()', async () => {
    const { processor, verifyStarted, outcomes } = createControlledProcessor({
      rejectOnAbort: true,
    });
    const { hub, serverPubkey, serverTransport, toolCalls } =
      await startPaidServer(processor);
    const client = await connectClient({ hub, serverPubkey });

    const call = client
      .callTool({ name: 'add', arguments: { a: 1, b: 2 } })
      .catch(() => undefined);
    try {
      await verifyStarted;
      await serverTransport.close();

      // Well under the multi-minute verify timeout: the poll was cut short.
      const outcome = await waitFor({
        produce: () => outcomes[0],
        timeoutMs: 1_000,
      });
      expect(outcome).toBe('rejected');
      expect(toolCalls).toHaveLength(0);
      expect(paymentAcceptedEvents(hub, serverPubkey)).toHaveLength(0);
    } finally {
      await client.close();
      await call;
    }
  }, 20_000);

  test('explicit gating: close() aborts the verify signal and a late settle clears pending instead of granting', async () => {
    const grantSpy = spyOn(AuthorizationStore.prototype, 'grant');
    const clearPendingSpy = spyOn(AuthorizationStore.prototype, 'clearPending');
    const { processor, verifyStarted, settle } = createControlledProcessor({
      rejectOnAbort: false,
    });
    const { hub, serverPubkey, serverTransport, toolCalls } =
      await startPaidServer(processor);
    const client = await connectClient({
      hub,
      serverPubkey,
      explicitGating: true,
    });
    try {
      // Explicit gating answers immediately with -32042 and verifies detached.
      await expect(
        client.callTool({ name: 'add', arguments: { a: 1, b: 2 } }),
      ).rejects.toMatchObject({ code: PAYMENT_REQUIRED_ERROR_CODE });

      const verifyParams = await verifyStarted;
      expect(verifyParams.abortSignal?.aborted).toBe(false);
      expect(grantSpy).not.toHaveBeenCalled();

      await serverTransport.close();

      expect(verifyParams.abortSignal?.aborted).toBe(true);

      settle();
      await Bun.sleep(100);

      expect(grantSpy).not.toHaveBeenCalled();
      expect(clearPendingSpy).toHaveBeenCalled();
      expect(toolCalls).toHaveLength(0);
    } finally {
      grantSpy.mockRestore();
      clearPendingSpy.mockRestore();
      await client.close();
    }
  }, 20_000);
});
