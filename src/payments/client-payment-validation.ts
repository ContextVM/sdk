import { z } from 'zod';
import type { ClientPaymentsOptions } from './client-payment-options.js';
import type {
  PaymentOption,
  PaymentPendingErrorData,
  PaymentRequiredErrorData,
} from './types.js';

const MAX_TIMER_MS = 2_147_483_647;
const amountSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const pmiSchema = z.string().regex(/^[a-z0-9-]+$/);
const timerSchema = z.number().finite().positive().max(MAX_TIMER_MS);

/** Internal payment failure with a stable application-visible reason. */
export class ClientPaymentError extends Error {
  public constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClientPaymentError';
  }
}

/** Runtime offer schema; unknown extension metadata is preserved. */
export const clientPaymentOptionSchema = z.object({
  amount: amountSchema,
  pmi: pmiSchema,
  pay_req: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0),
  description: z.string().optional(),
  ttl: z
    .number()
    .finite()
    .positive()
    .max(Number.MAX_SAFE_INTEGER / 1000)
    .optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});

const requiredSchema = z.object({
  instructions: z.string().optional(),
  payment_options: z
    .array(clientPaymentOptionSchema)
    .min(1)
    .max(100)
    .refine((options) => {
      const amounts = new Map<string, number>();
      for (const option of options) {
        const key = JSON.stringify([option.pmi, option.pay_req]);
        if (amounts.has(key) && amounts.get(key) !== option.amount)
          return false;
        amounts.set(key, option.amount);
      }
      return true;
    }),
});
const pendingSchema = z.object({
  instructions: z.string().optional(),
  retry_after: z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 1000)
    .optional(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ClientPaymentError('invalid_payment', 'Invalid payment message');
  }
  return result.data;
}

/** Validates a transparent payment offer before invoking policy or wallet code. */
export function parseClientPaymentOption(input: unknown): PaymentOption {
  return parse(clientPaymentOptionSchema, input);
}

/** Validates all explicit options, including options that might not be selected. */
export function parseClientPaymentRequired(
  input: unknown,
): PaymentRequiredErrorData {
  return parse(requiredSchema, input);
}

/** Validates pending backoff; omitted hints use the client's default. */
export function parseClientPaymentPending(
  input: unknown,
): PaymentPendingErrorData {
  return parse(pendingSchema, input === undefined ? {} : input);
}

/** Rejects invalid client configuration synchronously, before transport mutation. */
export function validateClientPaymentOptions(
  options: ClientPaymentsOptions,
): void {
  const schema = z.object({
    syntheticProgressIntervalMs: timerSchema.optional(),
    defaultPaymentTtlMs: timerSchema.optional(),
    minRetryDelayMs: z
      .number()
      .finite()
      .nonnegative()
      .max(MAX_TIMER_MS)
      .optional(),
    maxPendingRetries: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxTrackedPaymentAttempts: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    paymentInteraction: z.enum(['transparent', 'explicit_gating']).optional(),
    handlers: z.array(z.object({ pmi: pmiSchema })).optional(),
    limits: z
      .object({
        maxAmountByPmi: z.record(pmiSchema, amountSchema).optional(),
        maxAttempts: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
        timeoutMs: timerSchema.optional(),
      })
      .optional(),
  });
  if (!schema.safeParse(options).success) {
    throw new TypeError('Invalid client payment options');
  }
}
