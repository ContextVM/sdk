import type { CanonicalInvocationIdentity } from '../payments/types.js';
import type {
  PaymentStateAdmission,
  PaymentStateRecord,
  PaymentStateStore,
} from '../payments/payment-state-store.js';
import { paymentAuthorizationKey } from '../payments/payment-state-store.js';

export function authorizationInput(
  identity: CanonicalInvocationIdentity,
  leaseMs = 10000,
): PaymentStateAdmission {
  return {
    key: paymentAuthorizationKey(
      identity.clientPubkey,
      identity.invocationHash,
    ),
    mode: 'explicit_gating',
    clientPubkey: identity.clientPubkey,
    invocationHash: identity.invocationHash,
    requestEventId: `seed-${crypto.randomUUID()}`,
    leaseMs,
  };
}

export async function seedPending(
  store: PaymentStateStore,
  identity: CanonicalInvocationIdentity,
  leaseMs: number,
): Promise<PaymentStateRecord> {
  const reserved = await store.admit(authorizationInput(identity, leaseMs));
  if (reserved.status !== 'reserved')
    throw new Error(`Seed admission failed: ${reserved.status}`);
  return reserved.record;
}

export async function seedGrant(
  store: PaymentStateStore,
  identity: CanonicalInvocationIdentity,
  ttlMs: number,
): Promise<void> {
  const record = await seedPending(store, identity, 10000);
  const fence = { key: record.key, generation: record.generation };
  await store.transition({ ...fence, type: 'issuing' });
  await store.transition({
    ...fence,
    type: 'bind',
    invoice: { pmi: 'fake', amount: 10, pay_req: 'seed-invoice' },
    leaseMs: 10000,
  });
  await store.transition({ ...fence, type: 'grant', ttlMs });
}

export async function hasGrant(
  store: PaymentStateStore,
  identity: CanonicalInvocationIdentity,
): Promise<boolean> {
  const record = await store.read(
    paymentAuthorizationKey(identity.clientPubkey, identity.invocationHash),
  );
  return (
    record?.phase === 'granted' && (record.grantExpiresAtMs ?? 0) > Date.now()
  );
}

export async function pendingRemainingMs(
  store: PaymentStateStore,
  identity: CanonicalInvocationIdentity,
): Promise<number> {
  const record = await store.read(
    paymentAuthorizationKey(identity.clientPubkey, identity.invocationHash),
  );
  return record && ['reserved', 'issuing', 'pending'].includes(record.phase)
    ? Math.max(0, record.leaseExpiresAtMs - Date.now())
    : 0;
}
