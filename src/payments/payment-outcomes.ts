import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { PaymentStateRecord } from './payment-state-store.js';

/** Milestones describe server/wallet observations; published never means client receipt. */
export type PaymentOutcomeKind =
  | 'offer'
  | 'attempt'
  | 'attempt_handled'
  | 'attempt_declined'
  | 'unknown'
  | 'verified'
  | 'grant'
  | 'claim'
  | 'execution'
  | 'result_recorded'
  | 'published'
  | 'publication_failed'
  | 'expired'
  | 'evicted'
  | 'exhausted'
  | 'reconciliation_required'
  | 'reconciled';

/** Redacted correlation envelope. It never includes invoices, secrets, preimages, or result bodies. */
export interface PaymentOutcome {
  readonly kind: PaymentOutcomeKind;
  readonly atMs: number;
  readonly identity: string;
  readonly attempt?: string;
  readonly requestEventId?: string;
  readonly invoiceDigest?: string;
  readonly remedy?:
    'retry_publication' | 'reconcile_settlement' | 'application_policy';
}

/** Optional journal sink; recovery-critical state lives in PaymentStateStore regardless of this sink. */
export interface PaymentOutcomeJournal {
  append(outcome: PaymentOutcome): void | Promise<void>;
}

/** Observer and journal failures are isolated from authorization and execution. */
export interface PaymentOutcomeOptions {
  onPaymentOutcome?: (outcome: PaymentOutcome) => void | Promise<void>;
  paymentJournal?: PaymentOutcomeJournal;
}

/** Stable digest for correlation without exposing the payment request. */
export function paymentInvoiceDigest(invoice: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(invoice)));
}

/** Publishes only allowlisted fields and isolates failed or stalled application observers. */
export function emitPaymentOutcome(
  options: PaymentOutcomeOptions,
  outcome: PaymentOutcome,
): void {
  const redacted = Object.freeze({
    kind: outcome.kind,
    atMs: outcome.atMs,
    identity: outcome.identity,
    ...(outcome.attempt && { attempt: outcome.attempt }),
    ...(outcome.requestEventId && { requestEventId: outcome.requestEventId }),
    ...(outcome.invoiceDigest && { invoiceDigest: outcome.invoiceDigest }),
    ...(outcome.remedy && { remedy: outcome.remedy }),
  });
  for (const sink of [
    options.onPaymentOutcome,
    options.paymentJournal?.append.bind(options.paymentJournal),
  ]) {
    try {
      void Promise.resolve(sink?.(redacted)).catch(() => {});
    } catch {
      /* Optional observers cannot change payment state. */
    }
  }
}

/** Builds a redacted server milestone from an existing recorded attempt. */
export function recordPaymentOutcome(
  options: PaymentOutcomeOptions,
  record: PaymentStateRecord,
  kind: PaymentOutcomeKind,
  remedy?: PaymentOutcome['remedy'],
): void {
  emitPaymentOutcome(options, {
    kind,
    atMs: Date.now(),
    identity: paymentInvoiceDigest(
      JSON.stringify([record.clientPubkey, record.invocationHash]),
    ),
    attempt: record.generation,
    requestEventId: record.requestEventId,
    ...(record.invoice && {
      invoiceDigest: paymentInvoiceDigest(record.invoice.pay_req),
    }),
    remedy,
  });
}
