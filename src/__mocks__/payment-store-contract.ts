import { describe, expect, test } from 'bun:test';
import type {
  PaymentStateAdmission,
  PaymentStatePolicy,
  PaymentStateRecord,
  PaymentStateStore,
} from '../payments/payment-state-store.js';
import {
  paymentAuthorizationKey,
  paymentEventKey,
} from '../payments/payment-state-store.js';

export interface PaymentStoreHarness {
  store: PaymentStateStore;
  peer: PaymentStateStore;
  advance: (ms: number) => Promise<void>;
  close: () => Promise<void>;
}

export function admission(
  mode: 'transparent' | 'explicit_gating' = 'explicit_gating',
  eventId = 'event-1',
): PaymentStateAdmission {
  const clientPubkey = 'client';
  const invocationHash = 'hash';
  return {
    key:
      mode === 'transparent'
        ? paymentEventKey(clientPubkey, eventId)
        : paymentAuthorizationKey(clientPubkey, invocationHash),
    mode,
    clientPubkey,
    invocationHash,
    requestEventId: eventId,
    leaseMs: 10000,
  };
}

export async function bind(
  store: PaymentStateStore,
  input: PaymentStateAdmission,
): Promise<PaymentStateRecord> {
  const result = await store.admit(input);
  expect(result.status).toBe('reserved');
  const record = required(result.record);
  const fence = { key: record.key, generation: record.generation };
  expect(await store.transition({ ...fence, type: 'issuing' })).toBe(true);
  expect(
    await store.transition({
      ...fence,
      type: 'bind',
      invoice: {
        pmi: 'fake',
        amount: 10,
        pay_req: `invoice-${record.generation}`,
      },
      leaseMs: input.leaseMs,
    }),
  ).toBe(true);
  return required(await store.read(record.key));
}

export function paymentStoreContract(
  name: string,
  create: (
    policy?: Partial<PaymentStatePolicy>,
  ) => Promise<PaymentStoreHarness>,
): void {
  describe(name, () => {
    async function run(
      fn: (h: PaymentStoreHarness) => Promise<void>,
      policy?: Partial<PaymentStatePolicy>,
    ): Promise<void> {
      const h = await create(policy);
      try {
        await fn(h);
      } finally {
        await h.close();
      }
    }

    test('fractional millisecond durations persist as integer timestamps in every backend', async () =>
      run(async ({ store }) => {
        const input = { ...admission(), leaseMs: 10000.75 };
        const result = await store.admit(input);
        const record = required(result.record);
        expect(Number.isInteger(record.leaseExpiresAtMs)).toBe(true);
        const fence = { key: input.key, generation: record.generation };
        await store.transition({ ...fence, type: 'issuing' });
        expect(
          await store.transition({
            ...fence,
            type: 'bind',
            invoice: {
              pmi: 'fake',
              amount: 10,
              pay_req: 'invoice',
              ttl: 10.00075,
            },
            leaseMs: input.leaseMs,
          }),
        ).toBe(true);
        const pending = required(await store.read(input.key));
        expect(Number.isInteger(pending.leaseExpiresAtMs)).toBe(true);
        expect(Number.isInteger(pending.invoiceExpiresAtMs)).toBe(true);
        expect(
          await store.transition({ ...fence, type: 'grant', ttlMs: 10000.75 }),
        ).toBe(true);
        expect(
          Number.isInteger((await store.read(input.key))?.grantExpiresAtMs),
        ).toBe(true);
      }));

    test('late explicit offers and pending retries remain deduplicated after grant consumption', async () =>
      run(
        async ({ store, peer }) => {
          const input = admission();
          const record = await bind(store, input);
          expect(
            (await peer.admit({ ...input, requestEventId: 'pending-retry-1' }))
              .status,
          ).toBe('pending');
          expect(
            (await peer.admit({ ...input, requestEventId: 'pending-retry-2' }))
              .status,
          ).toBe('pending');
          expect(
            (await peer.admit({ ...input, requestEventId: 'overflow-retry' }))
              .status,
          ).toBe('capacity');
          expect(
            (await peer.admit({ ...input, requestEventId: 'pending-retry-1' }))
              .status,
          ).toBe('pending');
          await store.transition({
            key: input.key,
            generation: record.generation,
            type: 'grant',
            ttlMs: 10000,
          });
          const claimed = await peer.admit({
            ...input,
            requestEventId: 'paid-retry',
          });
          expect(claimed.status).toBe('claimed');
          expect(required(claimed.record).eventIds).toHaveLength(4);
          for (const id of [
            'event-1',
            'pending-retry-1',
            'pending-retry-2',
            'paid-retry',
          ])
            expect(
              (await store.admit({ ...input, requestEventId: id })).status,
            ).toBe('duplicate');
          expect(
            (
              await peer.admit({
                ...input,
                requestEventId: 'independent-invocation',
              })
            ).status,
          ).toBe('reserved');
        },
        { maxEventsPerPayment: 4 },
      ));

    test('consumed rights retain future-dated offer aliases until their last admission deadline', async () =>
      run(async ({ store }) => {
        const now = Math.floor(Date.now() / 1000);
        const input = {
          ...admission(),
          event: { id: 'event-1', author: 'client', createdAt: now + 30 },
        };
        const record = await bind(store, input);
        await store.transition({
          key: input.key,
          generation: record.generation,
          type: 'grant',
          ttlMs: 10000,
        });
        const retry = {
          ...input,
          requestEventId: 'paid-retry',
          event: { id: 'paid-retry', author: 'client', createdAt: now },
        };
        const claimed = await store.admit(retry);
        expect(claimed.status).toBe('claimed');
        expect(required(claimed.record).retainUntilMs).toBeNull();
        expect(
          required(claimed.record).replayExpiresAtMs,
        ).toBeGreaterThanOrEqual(
          (now + 30) * 1000 + store.policy.replayWindowMs,
        );
        expect((await store.admit(input)).status).toBe('duplicate');
      }));

    test('one worker reserves an invoice; matching requests stay pending at capacity', async () =>
      run(
        async ({ store, peer }) => {
          const input = admission();
          const results = await Promise.all([
            store.admit(input),
            peer.admit(input),
          ]);
          expect(results.map((r) => r.status).sort()).toEqual([
            'pending',
            'reserved',
          ]);
          const other = {
            ...input,
            key: paymentAuthorizationKey('other', 'hash'),
            clientPubkey: 'other',
          };
          expect((await peer.admit(other)).status).toBe('capacity');
          expect((await peer.admit(input)).status).toBe('pending');
        },
        { maxPendingPayments: 1 },
      ));

    test('capacity zero refuses both lifecycles before an attempt is reserved', async () =>
      run(
        async ({ store }) => {
          for (const mode of ['transparent', 'explicit_gating'] as const)
            expect((await store.admit(admission(mode))).status).toBe(
              'capacity',
            );
        },
        { maxPendingPayments: 0 },
      ));

    test('a paid grant remains claimable when retained-record capacity is one', async () =>
      run(
        async ({ store }) => {
          const input = admission();
          const record = await bind(store, input);
          await store.transition({
            key: input.key,
            generation: record.generation,
            type: 'grant',
            ttlMs: 10000,
          });
          const retry = { ...input, requestEventId: 'paid-retry' };
          expect((await store.admit(retry)).status).toBe('claimed');
          expect((await store.admit(retry)).status).toBe('duplicate');
          expect(
            (
              await store.read(
                paymentEventKey(input.clientPubkey, retry.requestEventId),
              )
            )?.phase,
          ).toBe('consumed');
        },
        { maxPaymentRecords: 1 },
      ));

    test('commands snapshot admission and invoice values before awaiting the backend', async () =>
      run(async ({ store }) => {
        const input = admission();
        const key = input.key;
        const pending = store.admit(input);
        input.key = paymentAuthorizationKey('changed', 'hash');
        input.clientPubkey = 'changed';
        const result = await pending;
        expect(result.status).toBe('reserved');
        const record = required(result.record);
        expect(record.key).toBe(key);
        expect(record.clientPubkey).toBe('client');
        const fence = { key, generation: record.generation };
        await store.transition({ ...fence, type: 'issuing' });
        const invoice = {
          pmi: 'fake',
          amount: 10,
          pay_req: 'original-invoice',
        };
        const binding = store.transition({
          ...fence,
          type: 'bind',
          invoice,
          leaseMs: 10000,
        });
        invoice.pay_req = 'changed-invoice';
        expect(await binding).toBe(true);
        expect((await store.read(key))?.invoice?.pay_req).toBe(
          'original-invoice',
        );
      }));

    test('an expired creation lease remains uncertain beyond normal record retention', async () =>
      run(
        async ({ store, advance }) => {
          const input = { ...admission(), leaseMs: 150 };
          const record = required((await store.admit(input)).record);
          await store.transition({
            key: input.key,
            generation: record.generation,
            type: 'issuing',
          });
          await advance(220);
          expect((await store.admit(input)).status).toBe('unknown');
          expect((await store.read(input.key))?.generation).toBe(
            record.generation,
          );
        },
        { replayWindowMs: 30 },
      ));

    test('one grant consumer wins; replaying its event never consumes a later grant', async () =>
      run(async ({ store, peer }) => {
        const input = admission();
        const record = await bind(store, input);
        expect(
          await store.transition({
            key: input.key,
            generation: record.generation,
            type: 'grant',
            ttlMs: 10000,
          }),
        ).toBe(true);
        const retry = { ...input, requestEventId: 'retry-event' };
        const results = await Promise.all([
          store.admit(retry),
          peer.admit(retry),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([
          'claimed',
          'duplicate',
        ]);
        const next = await bind(peer, {
          ...input,
          requestEventId: 'next-payment',
        });
        await peer.transition({
          key: input.key,
          generation: next.generation,
          type: 'grant',
          ttlMs: 10000,
        });
        expect((await store.admit(retry)).status).toBe('duplicate');
        expect((await store.read(input.key))?.phase).toBe('granted');
      }));

    test('expired reservations fence slow pricing and every old verifier mutation', async () =>
      run(async ({ store, peer, advance }) => {
        const input = { ...admission(), leaseMs: 150 };
        const old = required((await store.admit(input)).record);
        await advance(220);
        const next = await peer.admit({
          ...input,
          requestEventId: 'replacement',
          leaseMs: 10000,
        });
        expect(next.status).toBe('reserved');
        expect(required(next.record).generation).not.toBe(old.generation);
        const fence = { key: input.key, generation: old.generation };
        expect(
          await store.transition({ ...fence, type: 'grant', ttlMs: 10000 }),
        ).toBe(false);
        expect(await store.transition({ ...fence, type: 'expire' })).toBe(
          false,
        );
        expect(await store.transition({ ...fence, type: 'release' })).toBe(
          false,
        );
        expect(
          await store.transition({
            ...fence,
            type: 'bind',
            invoice: { amount: 1, pmi: 'fake', pay_req: 'superseded-invoice' },
            leaseMs: 10000,
          }),
        ).toBe(false);
        expect((await peer.read(input.key))?.generation).toBe(
          required(next.record).generation,
        );
        expect(
          await store.read(JSON.stringify(['attempt', old.generation])),
        ).toBeUndefined();
      }));

    test('an expired invoice-creation lease cannot mint another invoice', async () =>
      run(async ({ store, peer, advance }) => {
        const input = { ...admission(), leaseMs: 150 };
        const record = required((await store.admit(input)).record);
        const fence = { key: input.key, generation: record.generation };
        await store.transition({ ...fence, type: 'issuing' });
        await advance(220);
        expect((await peer.admit(input)).status).toBe('unknown');
        expect(
          await store.transition({
            ...fence,
            type: 'bind',
            invoice: { amount: 10, pmi: 'fake', pay_req: 'late-invoice' },
            leaseMs: 10000,
          }),
        ).toBe(false);
        expect((await peer.read(input.key))?.invoice?.pay_req).toBe(
          'late-invoice',
        );
        expect((await peer.read(input.key))?.phase).toBe('unknown');
      }));

    test('transparent replay after invoice expiry retains one invoice and one execution right', async () =>
      run(async ({ store, peer, advance }) => {
        const input = { ...admission('transparent'), leaseMs: 150 };
        const record = await bind(store, input);
        const fence = { key: input.key, generation: record.generation };
        expect(await store.transition({ ...fence, type: 'consume' })).toBe(
          true,
        );
        expect(await peer.transition({ ...fence, type: 'consume' })).toBe(
          false,
        );
        await advance(220);
        expect((await peer.admit(input)).status).toBe('duplicate');
        expect((await store.read(input.key))?.invoice?.pay_req).toBe(
          required(record.invoice).pay_req,
        );
        expect(await store.transition({ ...fence, type: 'dispatch' })).toBe(
          true,
        );
        expect((await peer.admit(input)).status).toBe('duplicate');
      }));

    test('pending leases expire independently of retained replay records', async () =>
      run(
        async ({ store, advance }) => {
          const input = { ...admission('transparent'), leaseMs: 150 };
          await bind(store, input);
          await advance(220);
          expect((await store.admit(input)).status).toBe('duplicate');
          expect(
            (await store.admit(admission('transparent', 'new-event'))).status,
          ).toBe('reserved');
        },
        { maxPendingPayments: 1 },
      ));

    test('live and expired paid grants are retained under record capacity pressure', async () =>
      run(
        async ({ store, peer, advance }) => {
          const input = admission();
          const record = await bind(store, input);
          await store.transition({
            key: input.key,
            generation: record.generation,
            type: 'grant',
            ttlMs: 40,
          });
          expect(
            (await peer.admit(admission('transparent', 'new-event'))).status,
          ).toBe('capacity');
          await advance(220);
          expect((await peer.admit(input)).status).toBe('expired');
          expect((await store.read(input.key))?.phase).toBe('granted');
        },
        { maxPaymentRecords: 1 },
      ));

    test('a failed pre-invoice quote can release only its own generation', async () =>
      run(async ({ store, peer }) => {
        const input = admission();
        const old = required((await store.admit(input)).record);
        expect(
          await store.transition({
            key: input.key,
            generation: old.generation,
            type: 'release',
          }),
        ).toBe(true);
        const current = required((await peer.admit(input)).record);
        expect(
          await store.transition({
            key: input.key,
            generation: old.generation,
            type: 'issuing',
          }),
        ).toBe(false);
        expect((await peer.read(input.key))?.generation).toBe(
          current.generation,
        );
      }));

    test('unknown invoice outcomes survive admission and cannot release their reservation', async () =>
      run(async ({ store, peer }) => {
        const input = admission();
        const record = required((await store.admit(input)).record);
        const fence = { key: input.key, generation: record.generation };
        await store.transition({ ...fence, type: 'issuing' });
        await store.transition({
          ...fence,
          type: 'uncertain',
          reason: 'acknowledgement_lost',
        });
        expect(await store.transition({ ...fence, type: 'release' })).toBe(
          false,
        );
        expect((await peer.admit(input)).status).toBe('unknown');
      }));

    test('rejects old, future, and mismatched authenticated event identities', async () =>
      run(async ({ store }) => {
        const input = admission('transparent');
        const now = Math.floor(Date.now() / 1000);
        for (const event of [
          {
            id: input.requestEventId,
            author: 'client',
            createdAt: now - 100000,
          },
          { id: input.requestEventId, author: 'client', createdAt: now + 120 },
          { id: 'different', author: 'client', createdAt: now },
          { id: input.requestEventId, author: 'other', createdAt: now },
        ])
          expect((await store.admit({ ...input, event })).status).toBe('stale');
      }));
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected payment state fixture');
  return value;
}
