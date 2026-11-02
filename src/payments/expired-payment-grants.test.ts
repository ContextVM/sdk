import { expect, test } from 'bun:test';
import type { JSONRPCErrorResponse } from '@contextvm/mcp-sdk/types.js';
import { admission, bind } from '../__mocks__/payment-store-contract.js';
import { InMemoryPaymentStateStore } from './in-memory-payment-state-store.js';
import { computeCanonicalInvocationHash } from './canonical-identity.js';
import { paymentAuthorizationKey } from './payment-state-store.js';
import { createExplicitGatingMiddleware } from './server-explicit-gating.js';
import type { PaymentProcessor } from './types.js';

async function fixture(timed = true, createdAt = 1000, startMs = 1_000_000) {
  let now = startMs;
  const store = new InMemoryPaymentStateStore(
    { maxPaymentRecords: 1, replayWindowMs: 1000 },
    () => now,
  );
  const invocationHash = computeCanonicalInvocationHash('tools/call', {
    name: 'paid',
  });
  const input = {
    ...admission(),
    key: paymentAuthorizationKey('client', invocationHash),
    invocationHash,
    leaseMs: 100,
    ...(timed && {
      event: { id: 'event-1', author: 'client', createdAt },
    }),
  };
  const record = await bind(store, input);
  const fence = { key: record.key, generation: record.generation };
  expect(await store.transition({ ...fence, type: 'grant', ttlMs: 40 })).toBe(
    true,
  );
  const resolve = (retentionMs = 2000): Promise<boolean> =>
    store.transition({ ...fence, type: 'resolve_expired_grant', retentionMs });
  const retry = () => ({
    ...input,
    requestEventId: 'retry',
    ...(timed && {
      event: {
        id: 'retry',
        author: 'client',
        createdAt: Math.floor(now / 1000),
      },
    }),
  });
  return {
    store,
    input,
    fence,
    resolve,
    retry,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

test('unresolved paid grants remain blocked beyond retention and replay deadlines', async () => {
  const h = await fixture();
  h.advance(10_000);
  expect((await h.store.admit(h.retry())).status).toBe('expired');
  expect((await h.store.read(h.input.key))?.retainUntilMs).toBeNull();
});

test('resolution cannot revoke a live grant or restore a consumed execution right', async () => {
  const h = await fixture();
  expect(await h.resolve()).toBe(false);
  expect((await h.store.admit(h.retry())).status).toBe('claimed');
  h.advance(50);
  expect(
    await h.store.transition({
      ...h.fence,
      key: '["event","client","retry"]',
      type: 'resolve_expired_grant',
      retentionMs: 0,
    }),
  ).toBe(false);
});

test('explicit resolution retains the grant through expiry plus the configured horizon', async () => {
  const h = await fixture();
  h.advance(40);
  expect(await h.resolve()).toBe(true);
  expect(await h.store.read(h.input.key)).toMatchObject({
    phase: 'granted',
    grantResolvedAtMs: 1_000_040,
    retainUntilMs: 1_002_040,
    invoice: { pay_req: `invoice-${h.fence.generation}` },
  });
  h.advance(1999);
  expect((await h.store.admit(h.retry())).status).toBe('expired');
  expect((await h.store.admit(admission('transparent', 'other'))).status).toBe(
    'capacity',
  );
  h.advance(1);
  expect((await h.store.admit(h.input)).status).toBe('stale');
  expect(await h.store.read(h.input.key)).toBeUndefined();
  const fresh = await h.store.admit(h.retry());
  expect(fresh.status).toBe('reserved');
  expect(fresh.record?.generation).not.toBe(h.fence.generation);
  expect(await h.resolve()).toBe(false);
  expect((await h.store.read(h.input.key))?.phase).toBe('reserved');
});

test('resolution cannot shorten replay protection even with zero configured retention', async () => {
  const h = await fixture();
  h.advance(40);
  expect(await h.resolve(0)).toBe(true);
  expect((await h.store.read(h.input.key))?.retainUntilMs).toBe(1_001_000);
  h.advance(959);
  expect((await h.store.admit(h.retry())).status).toBe('expired');
  h.advance(1);
  expect((await h.store.admit(h.input)).status).toBe('stale');
  expect((await h.store.admit(h.retry())).status).toBe('reserved');
});

test('operator resolution after the horizon permits collection on the next admission', async () => {
  const h = await fixture();
  h.advance(2040);
  expect((await h.store.admit(h.retry())).status).toBe('expired');
  expect(await h.resolve()).toBe(true);
  expect((await h.store.admit(h.retry())).status).toBe('reserved');
});

test('a future-dated offer retains its full replay deadline after resolution', async () => {
  const h = await fixture(true, 1030);
  h.advance(40);
  expect(await h.resolve(0)).toBe(true);
  expect((await h.store.read(h.input.key))?.retainUntilMs).toBe(1_031_000);
  h.advance(30_959);
  expect((await h.store.admit(h.retry())).status).toBe('expired');
  h.advance(1);
  expect((await h.store.admit(h.input)).status).toBe('stale');
  expect((await h.store.admit(h.retry())).status).toBe('reserved');
});

test.each(['pending', 'expired', 'unknown'] as const)(
  'an unpaid or uncertain %s invoice cannot be resolved as a paid grant',
  async (phase) => {
    let now = 1_000_000;
    const store = new InMemoryPaymentStateStore({}, () => now);
    const input = admission();
    const record = await bind(store, input);
    const fence = { key: record.key, generation: record.generation };
    if (phase === 'expired')
      await store.transition({ ...fence, type: 'expire' });
    if (phase === 'unknown')
      await store.transition({
        ...fence,
        type: 'uncertain',
        reason: 'timeout',
      });
    now += 10_000;
    expect(
      await store.transition({
        ...fence,
        type: 'resolve_expired_grant',
        retentionMs: 0,
      }),
    ).toBe(false);
    expect((await store.read(input.key))?.phase).toBe(phase);
    expect((await store.read(input.key))?.grantResolvedAtMs).toBeUndefined();
  },
);

test('concurrent resolution and retry cannot consume an expired paid right', async () => {
  const h = await fixture();
  h.advance(40);
  const [resolved, repeated, retry] = await Promise.all([
    h.resolve(),
    h.resolve(0),
    h.store.admit(h.retry()),
  ]);
  expect([resolved, repeated]).toEqual([true, false]);
  expect(retry.status).toBe('expired');
  expect((await h.store.read(h.input.key))?.retainUntilMs).toBe(1_002_040);
});

test.each([undefined, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])(
  'invalid or overflowing retention %s leaves the grant unresolved',
  async (retentionMs) => {
    const h = await fixture();
    h.advance(40);
    await expect(
      h.store.transition({
        ...h.fence,
        type: 'resolve_expired_grant',
        retentionMs: retentionMs as number,
      }),
    ).rejects.toThrow('Invalid expired-grant retention');
    expect(
      (await h.store.read(h.input.key))?.grantResolvedAtMs,
    ).toBeUndefined();
    expect((await h.store.read(h.input.key))?.retainUntilMs).toBeNull();
  },
);

test('untimed transports retain replay records after operator resolution', async () => {
  const h = await fixture(false);
  h.advance(40);
  expect(await h.resolve(0)).toBe(true);
  h.advance(10_000);
  expect((await h.store.admit(h.retry())).status).toBe('expired');
  expect((await h.store.read(h.input.key))?.retainUntilMs).toBeNull();
});

test('clock rollback cannot make a resolved, expired grant claimable', async () => {
  const h = await fixture();
  h.advance(40);
  expect(await h.resolve()).toBe(true);
  h.advance(-30);
  expect((await h.store.admit(h.retry())).status).toBe('expired');
});

test('middleware cannot issue another invoice or execute until operator resolution and collection', async () => {
  const startMs = Date.now();
  const h = await fixture(true, Math.floor(startMs / 1000), startMs);
  let invoices = 0;
  let executions = 0;
  let request = 0;
  const responses: JSONRPCErrorResponse[] = [];
  const processor: PaymentProcessor = {
    pmi: 'fake',
    async createPaymentRequired({ amount }) {
      invoices++;
      return { pmi: 'fake', amount, pay_req: 'new-invoice' };
    },
    async verifyPayment() {
      return {};
    },
  };
  const controller = new AbortController();
  const middleware = createExplicitGatingMiddleware({
    options: {
      processors: [processor],
      pricedCapabilities: [
        {
          method: 'tools/call',
          name: 'paid',
          amount: 10,
          currencyUnit: 'sats',
        },
      ],
    },
    authorizationStore: h.store,
    abortSignal: controller.signal,
    sendResponse: async (_peer, response) => {
      responses.push(response);
    },
  });
  const invoke = async (): Promise<void> => {
    const id = `request-${++request}`;
    await middleware(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'paid' } },
      {
        clientPubkey: 'client',
        paymentInteraction: 'explicit_gating',
        requestEvent: { ...h.retry().event!, id },
      },
      async () => {
        executions++;
      },
    );
  };
  try {
    h.advance(40);
    await invoke();
    expect(responses[responses.length - 1]?.error.data).toEqual({
      reason: 'payment_expired',
    });
    h.advance(2000);
    await invoke();
    expect([invoices, executions]).toEqual([0, 0]);
    expect(await h.resolve(3000)).toBe(true);
    await invoke();
    expect(responses[responses.length - 1]?.error.data).toEqual({
      reason: 'payment_expired',
    });
    expect([invoices, executions]).toEqual([0, 0]);
    h.advance(1000);
    await invoke();
    expect([invoices, executions]).toEqual([1, 0]);
    expect(responses[responses.length - 1]?.error.code).toBe(-32042);
  } finally {
    controller.abort();
  }
});
