import assert from 'node:assert/strict';
import {
  InMemoryPaymentStateStore,
  PaymentResultRecovery,
  paymentEventKey,
  paymentInvoiceDigest,
} from '../dist/esm/payments/index.js';

// Execute as a real module: Node 18's crypto globals differ from `node -e`.
const store = new InMemoryPaymentStateStore();
const key = paymentEventKey('client', 'event');
const admitted = await store.admit({
  key,
  mode: 'transparent',
  clientPubkey: 'client',
  requestEventId: 'event',
  invocationHash: 'hash',
  leaseMs: 10000,
});
assert.equal(admitted.status, 'reserved');
const fence = { key, generation: admitted.record.generation };
assert(await store.transition({ ...fence, type: 'issuing' }));
assert(
  await store.transition({
    ...fence,
    type: 'bind',
    invoice: { amount: 1, pmi: 'fake', pay_req: 'private-invoice' },
    leaseMs: 10000,
  }),
);
assert(await store.transition({ ...fence, type: 'settled', ttlMs: 10000 }));
assert(await store.transition({ ...fence, type: 'consume' }));
const recovery = new PaymentResultRecovery(store, {
  publicationLeaseMs: 10000,
});
const result = { jsonrpc: '2.0', id: 'event', result: { ok: true } };
const snapshot = {
  route: { clientPubkey: 'client', originalRequestId: 7 },
  expiresAtMs: Number.MAX_SAFE_INTEGER,
};
const publication = await recovery.prepare('event', result, snapshot);
assert(publication.publish);
await publication.framePublished(1);
await publication.complete();
assert.equal((await store.read(key)).delivery.status, 'published');
assert.equal(paymentInvoiceDigest('test').length, 64);
assert.equal(
  (
    await store.admit({
      key,
      mode: 'transparent',
      clientPubkey: 'client',
      requestEventId: 'event',
      invocationHash: 'hash',
      leaseMs: 10000,
    })
  ).status,
  'duplicate',
);
console.log(
  `${process.version}: payment lifecycle, result journal, and public exports passed`,
);
