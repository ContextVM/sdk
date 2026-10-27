import { z } from 'zod';
import type { ServerPaymentsOptions } from './server-payments.js';
import type {
  PaymentProcessor,
  PaymentRequired,
  PricedCapability,
  ResolvePriceResult,
} from './types.js';
import {
  paymentOptionSchema,
  paymentPmiSchema,
} from './payment-option-schema.js';
import {
  createPaymentStatePolicy,
  type PaymentStatePolicy,
} from './payment-state-store.js';

const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timer = z.number().finite().min(1).max(2_147_483_647);
const unit = z.string().trim().min(1);
const metadata = z.record(z.string(), z.unknown());
const quoteSchema = z.union([
  z
    .object({ reject: z.literal(true), message: z.string().optional() })
    .strict(),
  z.object({ waive: z.literal(true), meta: metadata.optional() }).strict(),
  z
    .object({
      amount,
      currencyUnit: unit.optional(),
      description: z.string().optional(),
      meta: metadata.optional(),
    })
    .strict(),
]);

/** Rejects values whose JSON representation would silently lose payment data. */
export function assertPaymentJson(value: unknown): void {
  JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      typeof item === 'bigint' ||
      (typeof item === 'number' && !Number.isFinite(item))
    )
      throw new TypeError('Payment data must be JSON serializable');
    return item;
  });
}

/** Validates configuration before middleware registration or announcement mutation. */
export function validateServerPaymentOptions(
  options: ServerPaymentsOptions,
): void {
  const capability = z
    .object({
      method: z.string().min(1),
      name: z.string().optional(),
      amount,
      maxAmount: amount.optional(),
      currencyUnit: unit,
      description: z.string().optional(),
    })
    .refine(
      (value) =>
        value.maxAmount === undefined || value.maxAmount >= value.amount,
    );
  const schema = z.object({
    disposeProcessorsOnClose: z.boolean().optional(),
    processors: z.array(
      z.object({
        pmi: paymentPmiSchema,
        currencyUnit: unit.optional(),
      }),
    ),
    pricedCapabilities: z.array(capability),
    paymentTtlMs: timer.optional(),
    authorizationTtlMs: timer.optional(),
    paymentInteraction: z.enum(['optional', 'transparent']).optional(),
  });
  if (!schema.safeParse(options).success)
    throw new TypeError('Invalid server payment options');
  const policy = createPaymentStatePolicy(options);
  if (options.stateStore) {
    for (const key of Object.keys(policy) as Array<keyof PaymentStatePolicy>) {
      if (
        options[key] !== undefined &&
        options[key] !== options.stateStore.policy[key]
      )
        throw new TypeError(`Payment store policy mismatch: ${key}`);
    }
  }
}

/** Checks inclusive advertised bounds and the unchanged configured amount unit. */
export function validateServerQuote(
  input: unknown,
  priced: PricedCapability,
): ResolvePriceResult {
  const quote = quoteSchema.parse(input);
  assertPaymentJson(quote);
  if (
    'amount' in quote &&
    (quote.amount < priced.amount ||
      quote.amount > (priced.maxAmount ?? priced.amount) ||
      (quote.currencyUnit !== undefined &&
        quote.currencyUnit !== priced.currencyUnit))
  )
    throw new TypeError(
      'Payment quote is outside its advertised range or unit',
    );
  return quote;
}

/** Validates the processor's result before binding or advertising an invoice. */
export function validateProcessorPayment(
  input: unknown,
  processor: PaymentProcessor,
  quotedAmount: number,
): PaymentRequired {
  const invoice = paymentOptionSchema.parse(input);
  if (
    (invoice.ttl !== undefined && invoice.ttl * 1000 < 1) ||
    invoice.pmi !== processor.pmi ||
    invoice.amount !== quotedAmount
  )
    throw new TypeError('Payment processor changed the quoted amount or PMI');
  assertPaymentJson(invoice);
  return JSON.parse(JSON.stringify(invoice)) as PaymentRequired;
}
