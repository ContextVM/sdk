import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';

/**
 * A priced capability pattern, consistent with server-side authorization exclusions.
 */
export interface PricedCapabilityPattern {
  /** JSON-RPC method (example: `tools/call`) */
  method: string;
  /** Optional capability name (example: tool name for `tools/call`) */
  name?: string;
}

/**
 * Server-side pricing metadata for a capability pattern.
 */
export interface PricedCapability extends PricedCapabilityPattern {
  /** Amount requested for this invocation. Unit interpretation is implementation-defined. */
  amount: number;
  /**
   * Optional upper bound for variable pricing. When set, `cap` tag uses range format
   * `"<amount>-<maxAmount>"` (CEP-8).
   */
  maxAmount?: number;
  /** Currency/unit label for display and `cap` tag advertisement (example: `sats`). */
  currencyUnit: string;
  /** Optional human-readable description for the payment request. */
  description?: string;
}

/** Nostr `cap` tag as defined by CEP-8. */
export type CapTag = [
  'cap',
  capabilityIdentifier: string,
  price: string,
  currencyUnit: string,
];

/** Nostr `pmi` tag as defined by CEP-8. */
export type PmiTag = ['pmi', pmi: string];

/** Nostr `direct_payment` tag as defined by CEP-8 (optional bearer-asset optimization). */
export type DirectPaymentTag = ['direct_payment', pmi: string, payload: string];

/** Nostr `change` tag as defined by CEP-8 (optional settlement artifact for bearer-asset methods). */
export type ChangeTag = ['change', pmi: string, payload: string];

/** A CEP-8 payment-required notification (JSON-RPC notification). */
export type PaymentRequiredNotification = JSONRPCNotification & {
  method: 'notifications/payment_required';
  params: {
    amount: number;
    pay_req: string;
    pmi: string;
    description?: string;
    /** Time-to-live in seconds (CEP-8). */
    ttl?: number;
    _meta?: Record<string, unknown>;
  };
};

/**
 * CEP-8 payment interaction modes.
 *
 * These are the wire/session-level modes negotiated via the `payment_interaction`
 * tag: `transparent` (default) and `explicit_gating` (opt-in).
 */
export type PaymentInteractionMode = 'transparent' | 'explicit_gating';

/**
 * Server-side policy for which payment interaction lifecycles it accepts.
 *
 * This is a server configuration concern, distinct from the wire-level
 * {@link PaymentInteractionMode}. It mirrors the OPTIONAL policy used for
 * encryption and gift wrapping, where the peer's chosen mode is mirrored rather
 * than forced.
 *
 * - `optional`: Accept both lifecycles and mirror the client's requested mode
 *   for the session (the default). A client that requests `explicit_gating`
 *   gets it; a client that omits the tag or requests `transparent` stays on the
 *   transparent lifecycle.
 * - `transparent`: Transparent-only. Reject `explicit_gating` requests with a
 *   `-32602` negotiation error per CEP-8 effective-mode disclosure.
 */
export type PaymentInteractionPolicy = 'optional' | 'transparent';

/** A single payment option inside a -32042 error.data.payment_options entry. */
export interface PaymentOption {
  amount: number;
  pmi: string;
  pay_req: string;
  description?: string;
  ttl?: number;
  _meta?: Record<string, unknown>;
}

/** Shape of error.data for -32042 Payment Required. */
export interface PaymentRequiredErrorData {
  instructions?: string;
  payment_options: PaymentOption[];
}

/** Shape of error.data for -32043 Payment Pending. */
export interface PaymentPendingErrorData {
  instructions?: string;
  retry_after?: number;
}

/** Nostr `payment_interaction` tag as defined by CEP-8. */
export type PaymentInteractionTag = [
  'payment_interaction',
  PaymentInteractionMode,
];

/**
 * Canonical invocation identity for explicit-gating authorization matching.
 * `invocationHash` excludes `params._meta`, so retries with regenerated
 * transport metadata (e.g. progressToken) still match a paid authorization;
 * only the semantic `method` and params must be preserved when retrying.
 */
export interface CanonicalInvocationIdentity {
  clientPubkey: string;
  /** Hex-encoded SHA-256 of JCS({method, params}) with `params._meta` excluded. */
  invocationHash: string;
}

/** A CEP-8 payment-accepted notification (JSON-RPC notification). */
export type PaymentAcceptedNotification = JSONRPCNotification & {
  method: 'notifications/payment_accepted';
  params: {
    amount: number;
    pmi: string;
    _meta?: Record<string, unknown>;
  };
};

/** A CEP-8 payment-rejected notification (JSON-RPC notification). */
export type PaymentRejectedNotification = JSONRPCNotification & {
  method: 'notifications/payment_rejected';
  params: {
    pmi: string;
    amount?: number;
    message?: string;
  };
};

export interface PaymentHandlerRequest {
  amount: number;
  pay_req: string;
  /** The PMI requested by the server (e.g. "bitcoin-lightning-bolt11"). */
  pmi: string;
  description?: string;
  /** Time-to-live in seconds from the server's `payment_required` (CEP-8). */
  ttl?: number;
  /** Transparency metadata from the server's `payment_required._meta`. */
  _meta?: Record<string, unknown>;
  requestEventId: string;
}

/**
 * Client-side module that can execute a payment for a single PMI in-band
 * (e.g. a wallet handler). A client that wants to pay out-of-band instead
 * simply omits {@link ClientPaymentsOptions.handlers}.
 */
export interface PaymentHandler {
  /** The PMI this handler supports (e.g. "bitcoin-lightning-bolt11"). */
  readonly pmi: string;

  /** Optional policy check that can decline handling. */
  canHandle?(req: PaymentHandlerRequest): boolean | Promise<boolean>;

  /** Execute the payment (wallet action). */
  handle(req: PaymentHandlerRequest): Promise<void>;
}

export interface PaymentProcessorCreateParams {
  amount: number;
  description?: string;
  requestEventId: string;
  clientPubkey: string;
}

export interface PaymentProcessorVerifyParams {
  pay_req: string;
  requestEventId: string;
  clientPubkey: string;

  /** Optional abort signal to stop verification early (timeout, shutdown, etc). */
  abortSignal?: AbortSignal;
}

export type ResolvePriceQuote = {
  /** Final amount to charge for this specific invocation. */
  amount: number;
  /** Optional override for the payment request description. */
  description?: string;
  /** Optional transparency metadata attached to `payment_required.params._meta`. */
  meta?: Record<string, unknown>;
};

export type ResolvePriceRejection = {
  /** Signal that the request should be rejected without asking for payment. */
  reject: true;
  /** Optional human-readable message explaining the rejection. */
  message?: string;
};

export type ResolvePriceWaiver = {
  /** Signal that payment is waived/covered and the request should proceed immediately. */
  waive: true;
  /** Optional transparency metadata (e.g., remaining balance) attached to `payment_accepted._meta` if emitted. */
  meta?: Record<string, unknown>;
};

/**
 * Helper factory for {@link ResolvePriceRejection}.
 *
 * Prefer this over writing the object literal directly — the discriminant
 * `reject: true` is easy to mistype as `rejected: true`, and TypeScript's
 * union excess-property checking will not catch the mistake at a return site.
 */
export function rejectPrice(message?: string): ResolvePriceRejection {
  return { reject: true, message };
}

/**
 * Helper factory for {@link ResolvePriceWaiver}.
 */
export function waivePrice(meta?: Record<string, unknown>): ResolvePriceWaiver {
  return {
    waive: true,
    ...(meta !== undefined && { meta }),
  };
}

/**
 * Helper factory for {@link ResolvePriceQuote}.
 *
 * Provides a named constructor that pairs naturally with {@link rejectPrice}.
 * Supports optional description and metadata overrides for full CEP-8 flexibility.
 */
export function quotePrice(
  amount: number,
  options?: { description?: string; meta?: Record<string, unknown> },
): ResolvePriceQuote {
  return {
    amount,
    ...(options?.description !== undefined && {
      description: options.description,
    }),
    ...(options?.meta !== undefined && { meta: options.meta }),
  };
}

/**
 * Result of resolvePrice callback.
 *
 * - Return a quote object to proceed with payment flow.
 * - Return a rejection object to emit `payment_rejected` without asking for payment.
 */
export type ResolvePriceResult =
  | ResolvePriceQuote
  | ResolvePriceRejection
  | ResolvePriceWaiver;

/**
 * Server-side callback for dynamic pricing.
 *
 * Note: `cap` tags are a discovery surface; this callback determines the final quote
 * used when emitting `notifications/payment_required`.
 */
export type ResolvePriceFn = (params: {
  capability: PricedCapability;
  request: JSONRPCRequest;
  clientPubkey: string;
  requestEventId: string;
}) => Promise<ResolvePriceResult>;

/**
 * The structure returned by a PaymentProcessor when a new payment is issued.
 */
export interface PaymentRequired {
  amount: number;
  pay_req: string;
  description?: string;
  pmi: string;
  /** Time-to-live in seconds (CEP-8). */
  ttl?: number;
  _meta?: Record<string, unknown>;
}

/**
 * Server-side module that can issue and verify payments for a single PMI.
 */
export interface PaymentProcessor {
  /** The PMI this processor can issue/verify */
  readonly pmi: string;

  /** Create a payment request for a specific capability invocation */
  createPaymentRequired(
    params: PaymentProcessorCreateParams,
  ): Promise<PaymentRequired>;

  /** Wait for and/or verify settlement for a previously issued pay_req */
  verifyPayment(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }>;
}

export interface ServerPaymentsContext {
  /** The client pubkey associated with the inbound request. */
  clientPubkey: string;

  /**
   * Optional list of client-advertised PMIs (ordered by client preference).
   *
   * Source: Nostr event tags (e.g. multiple `['pmi', '<pmi>']`).
   */
  clientPmis?: readonly string[];

  /**
   * The negotiated payment interaction mode for the session.
   */
  paymentInteraction?: PaymentInteractionMode;
}

/**
 * Minimal capability required by server-side payments to emit CEP-8 correlated notifications.
 */
export interface CorrelatedNotificationSender {
  sendNotification(
    clientPubkey: string,
    notification: JSONRPCNotification,
    requestEventId: string,
  ): Promise<void>;
}

export type ServerForwardFn = (message: JSONRPCMessage) => Promise<void>;

export type ServerMiddlewareFn = (
  message: JSONRPCMessage,
  ctx: ServerPaymentsContext,
  forward: ServerForwardFn,
) => Promise<void>;

export function isJsonRpcRequest(
  message: JSONRPCMessage,
): message is JSONRPCRequest {
  return (
    (message as JSONRPCRequest).method !== undefined &&
    (message as JSONRPCRequest).id !== undefined
  );
}
