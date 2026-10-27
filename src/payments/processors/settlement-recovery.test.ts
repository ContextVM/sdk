import { describe, expect, test } from 'bun:test';
import {
  LnBolt11NwcPaymentProcessor,
  type NwcClientLike,
} from './ln-bolt11-nwc-payment-processor.js';
import { LnBolt11LnbitsPaymentProcessor } from './ln-bolt11-lnbits-payment-processor.js';
import { LnBolt11LnbitsPaymentHandler } from '../handlers/ln-bolt11-lnbits-payment-handler.js';
import type { NwcNotificationPayload, NwcResponse } from '../nip47/types.js';

const identity = { requestEventId: 'event', clientPubkey: 'client' };
function nwcFixture(
  options: {
    early?: boolean;
    missing?: boolean;
    delayedSubscribe?: boolean;
  } = {},
): {
  processor: LnBolt11NwcPaymentProcessor;
  stats: {
    lookups: number;
    subscriptions: number;
    unsubscribes: number;
    disconnects: number;
  };
  setSettled: () => void;
} {
  const stats = {
    lookups: 0,
    subscriptions: 0,
    unsubscribes: 0,
    disconnects: 0,
  };
  let settled = !!options.early;
  const client: NwcClientLike = {
    async request<M extends string, P, R>(params: {
      method: M;
      request: { method: M; params: P };
      resultType: M;
    }): Promise<NwcResponse<M, R>> {
      if (params.method === 'lookup_invoice') stats.lookups++;
      return {
        result_type: params.method,
        error: null,
        result:
          params.method === 'make_invoice'
            ? {
                invoice: 'invoice',
                ...(options.missing ? {} : { payment_hash: 'hash' }),
              }
            : {
                state: settled ? 'settled' : 'pending',
                payment_hash: 'hash',
                type: 'incoming',
              },
      } as NwcResponse<M, R>;
    },
    async fetchInfoNotificationTypes() {
      return new Set(['payment_received']);
    },
    async subscribeNotifications(params: {
      onNotification: (payload: NwcNotificationPayload) => void;
    }) {
      stats.subscriptions++;
      if (options.early)
        params.onNotification({
          notification_type: 'payment_received',
          notification: { payment_hash: 'hash' },
        });
      if (options.delayedSubscribe)
        await new Promise((resolve) => setTimeout(resolve, 15));
      return () => {
        stats.unsubscribes++;
      };
    },
    async disconnect() {
      stats.disconnects++;
    },
  };
  return {
    stats,
    setSettled: () => {
      settled = true;
    },
    processor: new LnBolt11NwcPaymentProcessor({
      nwcConnectionString: 'unused',
      connection: {
        walletPubkey: 'wallet',
        clientSecretKeyHex: '0'.repeat(64),
        relays: [],
      },
      nwcClient: client,
      enableNotificationVerification: true,
      pollIntervalMs: 2,
      ttlSeconds: 1,
    }),
  };
}

describe('settlement recognition and cancellation', () => {
  for (const missing of [false, true])
    test(`early/missed notifications recover through lookup, missing hash=${missing}`, async () => {
      const { processor, stats } = nwcFixture({ early: true, missing });
      const invoice = await processor.createPaymentRequired({
        ...identity,
        amount: 1,
      });
      expect(
        await processor.verifyPayment({
          ...identity,
          pay_req: invoice.pay_req,
        }),
      ).toEqual({ _meta: { payment_hash: 'hash' } });
      expect(stats.lookups).toBe(1);
      await processor.dispose();
      await processor.dispose();
      expect(stats.unsubscribes).toBe(1);
      expect(stats.disconnects).toBe(0);
    });

  test('broken notifications do not strand settlement; cancelling one shared waiter preserves the other', async () => {
    const { processor, stats, setSettled } = nwcFixture();
    const abort = new AbortController();
    const first = processor.verifyPayment({
      ...identity,
      pay_req: 'invoice',
      abortSignal: abort.signal,
    });
    const rejected = first.catch((error) => error);
    const second = processor.verifyPayment({ ...identity, pay_req: 'invoice' });
    abort.abort();
    setSettled();
    expect(await rejected).toBeInstanceOf(Error);
    expect(await second).toEqual({ _meta: { payment_hash: 'hash' } });
    expect(stats.subscriptions).toBe(1);
    await processor.dispose();
  });

  test('late subscription setup is released after disposal', async () => {
    const { processor, stats } = nwcFixture({ delayedSubscribe: true });
    const work = processor.verifyPayment({ ...identity, pay_req: 'invoice' });
    const rejected = work.catch((error) => error);
    await processor.dispose();
    expect(await rejected).toBeInstanceOf(Error);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(stats.unsubscribes).toBe(1);
  });

  for (const stage of ['create', 'decode', 'status', 'wallet'] as const)
    test(`LNbits ${stage} receives abort and cannot continue after cancellation`, async () => {
      const signals: AbortSignal[] = [];
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const http = (async (
        _input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        if (stage === 'status' && String(_input).endsWith('/decode'))
          return Response.json({ payment_hash: 'hash' });
        signals.push(init?.signal as AbortSignal);
        reached();
        // Models an HTTP implementation that ignores abort: the adapter must still return promptly.
        return await new Promise<Response>(() => {});
      }) as typeof fetch;
      const processor = new LnBolt11LnbitsPaymentProcessor({
        lnbitsUrl: 'https://wallet.invalid',
        lnbitsApiKey: 'read-secret',
        fetch: http,
      });
      const handler = new LnBolt11LnbitsPaymentHandler({
        lnbitsUrl: 'https://wallet.invalid',
        lnbitsAdminKey: 'admin-secret',
        fetch: http,
      });
      const controller = new AbortController();
      const work =
        stage === 'create'
          ? processor.createPaymentRequired({
              ...identity,
              amount: 1,
              abortSignal: controller.signal,
            })
          : stage === 'wallet'
            ? handler.handle({
                ...identity,
                amount: 1,
                pmi: processor.pmi,
                pay_req: 'invoice',
                abortSignal: controller.signal,
              })
            : processor.verifyPayment({
                ...identity,
                pay_req: 'invoice',
                abortSignal: controller.signal,
              });
      const rejected = work.catch((error) => error);
      await entered;
      controller.abort();
      expect(await rejected).toBeInstanceOf(Error);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      await processor.dispose();
      await handler.dispose();
    });
});
