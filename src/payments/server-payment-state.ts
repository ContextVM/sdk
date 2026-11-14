import type { JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import type { PaymentInteractionMode, ServerPaymentsContext } from './types.js';
import type {
  PaymentStateAdmission,
  PaymentStateRecord,
  PaymentStateStore,
} from './payment-state-store.js';
import {
  paymentAuthorizationKey,
  paymentEventKey,
} from './payment-state-store.js';
import { InMemoryPaymentStateStore } from './in-memory-payment-state-store.js';
import { computeCanonicalInvocationHash } from './canonical-identity.js';

/** Uses the injected backend consistently for both lifecycles. */
export function serverPaymentStore(
  options: ServerPaymentsOptions,
): PaymentStateStore {
  return options.stateStore ?? new InMemoryPaymentStateStore(options);
}

/** Derives peer-scoped admission from authenticated event context, never params metadata. */
export function serverPaymentAdmission(
  message: JSONRPCRequest,
  ctx: ServerPaymentsContext,
  mode: PaymentInteractionMode,
  leaseMs: number,
): PaymentStateAdmission {
  const requestEventId = ctx.requestEvent?.id ?? String(message.id);
  const invocationHash = computeCanonicalInvocationHash(
    message.method,
    message.params,
  );
  return {
    key:
      mode === 'transparent'
        ? paymentEventKey(ctx.clientPubkey, requestEventId)
        : paymentAuthorizationKey(ctx.clientPubkey, invocationHash),
    mode,
    clientPubkey: ctx.clientPubkey,
    requestEventId,
    invocationHash,
    leaseMs,
    event: ctx.requestEvent,
  };
}

/** Failed quote work can be retried; ambiguous invoice creation cannot be repeated. */
export async function abandonServerPayment(
  store: PaymentStateStore,
  record: PaymentStateRecord,
): Promise<void> {
  const fence = { key: record.key, generation: record.generation };
  if (
    !(await store.transition({
      ...fence,
      type: 'uncertain',
      reason: 'payment_work_failed',
    }))
  )
    await store.transition({ ...fence, type: 'release' });
}
