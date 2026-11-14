import { describe, expect, test } from 'bun:test';
import { InMemoryPaymentStateStore } from './in-memory-payment-state-store.js';
import {
  paymentAuthorizationKey,
  paymentEventKey,
  type PaymentStateRecord,
} from './payment-state-store.js';
import {
  PaymentResultRecovery,
  reconcilePaymentAttempt,
  paymentRecoveryStatus,
} from './payment-recovery.js';
import {
  emitPaymentOutcome,
  paymentInvoiceDigest,
  type PaymentOutcome,
} from './payment-outcomes.js';
import type { PaymentProcessor } from './types.js';
import type { RouteSnapshot } from '../transport/nostr-server/correlation-store.js';

async function issued(
  store: InMemoryPaymentStateStore,
  mode: 'explicit_gating' | 'transparent' = 'explicit_gating',
): Promise<PaymentStateRecord> {
  const key =
    mode === 'transparent'
      ? paymentEventKey('client', 'offer')
      : paymentAuthorizationKey('client', 'hash');
  const result = await store.admit({
    key,
    mode,
    clientPubkey: 'client',
    requestEventId: 'offer',
    invocationHash: 'hash',
    leaseMs: 10,
  });
  const record = result.record!;
  expect(
    await store.transition({
      key,
      generation: record.generation,
      type: 'issuing',
    }),
  ).toBe(true);
  expect(
    await store.transition({
      key,
      generation: record.generation,
      type: 'bind',
      invoice: { pmi: 'fake', pay_req: 'private-invoice', amount: 1 },
      leaseMs: 10,
    }),
  ).toBe(true);
  return (await store.read(key))!;
}

const snapshot: RouteSnapshot = {
  route: { clientPubkey: 'client', originalRequestId: 42, wrapKind: 21059 },
  session: {
    isInitialized: true,
    isEncrypted: true,
    hasSentCommonTags: true,
    supportsEncryption: true,
    supportsEphemeralEncryption: true,
    supportsOversizedTransfer: false,
    supportsOpenStream: false,
  },
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};

describe('recorded settlement and result recovery', () => {
  test('late settlement recovers the same generation, one grant, no invoice creation', async () => {
    let now = Date.now();
    const store = new InMemoryPaymentStateStore({}, () => now);
    const record = await issued(store);
    now += 20;
    expect(
      (
        await store.admit({
          key: record.key,
          mode: record.mode,
          clientPubkey: 'client',
          requestEventId: 'retry',
          invocationHash: 'hash',
          leaseMs: 10,
        })
      ).status,
    ).toBe('unknown');
    let queries = 0;
    const processor: PaymentProcessor = {
      pmi: 'fake',
      createPaymentRequired: async () => {
        throw new Error('Must never issue another invoice');
      },
      verifyPayment: async (input) => {
        expect(input.pay_req).toBe('private-invoice');
        queries++;
        return {};
      },
    };
    const result = await reconcilePaymentAttempt({
      store,
      key: record.key,
      generation: record.generation,
      processors: [processor],
      authorizationTtlMs: 10000,
    });
    expect(result.status).toBe('grant_available');
    expect(queries).toBe(1);
    const claims = await Promise.all(
      ['a', 'b'].map((requestEventId) =>
        store.admit({
          key: record.key,
          mode: record.mode,
          clientPubkey: 'client',
          requestEventId,
          invocationHash: 'hash',
          leaseMs: 10,
        }),
      ),
    );
    expect(claims.filter((x) => x.status === 'claimed')).toHaveLength(1);
    expect(
      await reconcilePaymentAttempt({
        store,
        key: record.key,
        generation: 'superseded',
        processors: [processor],
        authorizationTtlMs: 10000,
      }),
    ).toEqual({ status: 'superseded', remedy: 'application_policy' });
    expect(queries).toBe(1);
  });

  test('concurrent reconcilers query once and backend errors never request payment', async () => {
    const store = new InMemoryPaymentStateStore();
    const record = await issued(store);
    let settle!: () => void;
    const ready = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let queries = 0;
    const processor: PaymentProcessor = {
      pmi: 'fake',
      createPaymentRequired: async () => {
        throw new Error('No new invoice');
      },
      verifyPayment: async () => {
        queries++;
        await ready;
        return {};
      },
    };
    const params = {
      store,
      key: record.key,
      generation: record.generation,
      processors: [processor],
      authorizationTtlMs: 10000,
    };
    const a = reconcilePaymentAttempt(params);
    const b = reconcilePaymentAttempt(params);
    settle();
    await Promise.all([a, b]);
    expect(queries).toBe(1);
  });

  test('paid result persists before send, retry after recreation publishes once without re-execution', async () => {
    const store = new InMemoryPaymentStateStore();
    const record = await issued(store, 'transparent');
    const fence = { key: record.key, generation: record.generation };
    expect(
      await store.transition({ ...fence, type: 'settled', ttlMs: 10000 }),
    ).toBe(true);
    expect(await store.transition({ ...fence, type: 'consume' })).toBe(true);
    const outcomes: PaymentOutcome[] = [];
    const recovery = new PaymentResultRecovery(store, {
      publicationLeaseMs: 10000,
      onPaymentOutcome: (event) => {
        outcomes.push(event);
        throw new Error('observer-secret');
      },
    });
    const response = {
      jsonrpc: '2.0' as const,
      id: 'offer',
      result: { secretResult: 'content' },
    };
    const publication = await recovery.prepare('offer', response, snapshot);
    expect((await store.read(record.key))?.delivery?.response).toEqual(
      response,
    );
    await publication.failed();
    expect(paymentRecoveryStatus((await store.read(record.key))!).status).toBe(
      'undelivered',
    );
    const restarted = new PaymentResultRecovery(store, {
      publicationLeaseMs: 10000,
    });
    let sends = 0;
    await restarted.replay(
      'client',
      'offer',
      (restored) => {
        expect(restored.session?.isEncrypted).toBe(true);
        expect(restored.route.wrapKind).toBe(21059);
      },
      async (saved) => {
        expect(saved).toEqual(response);
        const retry = await restarted.prepare('offer', saved, snapshot);
        sends++;
        await retry.framePublished(1);
        await retry.complete();
      },
    );
    await restarted.replay(
      'client',
      'offer',
      () => {},
      async () => {
        sends++;
      },
    );
    expect(sends).toBe(1);
    expect(JSON.stringify(outcomes)).not.toContain('private-invoice');
    expect(JSON.stringify(outcomes)).not.toContain('secretResult');
    expect(JSON.stringify(outcomes)).not.toContain('observer-secret');
  });

  test('observer/journal throws and rejections are isolated and secret fields never escape', async () => {
    const collected: PaymentOutcome[] = [];
    emitPaymentOutcome(
      {
        onPaymentOutcome: (event) => {
          collected.push(event);
          throw new Error('secret');
        },
        paymentJournal: {
          append: async () => {
            throw new Error('secret');
          },
        },
      },
      {
        kind: 'verified',
        atMs: 1,
        identity: 'identity',
        invoiceDigest: paymentInvoiceDigest('preimage-secret'),
        ...{ preimage: 'preimage-secret', pay_req: 'invoice-secret' },
      },
    );
    await Bun.sleep(0);
    expect(collected).toHaveLength(1);
    expect(JSON.stringify(collected)).not.toContain('secret');
  });

  test('a fresh default store cannot recover results retained by another store', async () => {
    const store = new InMemoryPaymentStateStore();
    const record = await issued(store, 'transparent');
    const fence = { key: record.key, generation: record.generation };
    await store.transition({ ...fence, type: 'settled', ttlMs: 10000 });
    await store.transition({ ...fence, type: 'consume' });
    const response = { jsonrpc: '2.0' as const, id: 'offer', result: {} };
    const recovery = new PaymentResultRecovery(store, {
      publicationLeaseMs: 10000,
    });
    await recovery.retain('offer', response, snapshot);
    expect((await store.read(record.key))?.delivery?.response).toEqual(
      response,
    );

    const fresh = new PaymentResultRecovery(new InMemoryPaymentStateStore(), {
      publicationLeaseMs: 10000,
    });
    let publications = 0;
    await expect(
      fresh.replay(
        'client',
        'offer',
        () => {},
        async () => {
          publications++;
        },
      ),
    ).rejects.toThrow('No recorded paid result');
    expect(publications).toBe(0);
  });
});
