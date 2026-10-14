import type { JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import type { OriginalRequestContext } from '../transport/nostr-client/correlation-store.js';
import type {
  PaymentHandler,
  PaymentHandlerRequest,
  PaymentInteractionMode,
  PaymentOption,
} from './types.js';

/** Limits for one request lifecycle, including replacement invoices. */
export interface ClientPaymentLimits {
  /**
   * Cumulative advertised amount approved per PMI, in that PMI's amount unit.
   * When set, unlisted PMIs cannot be paid automatically. Multi-option explicit
   * callbacks reserve the largest offered amount for each PMI conservatively.
   * Wallet handlers must verify the settlement payload amount; this generic
   * policy cannot decode or constrain arbitrary PMI payloads or external wallets.
   */
  maxAmountByPmi?: Readonly<Record<string, number>>;
  /** Maximum distinct offers passed to policy/approval work. Zero refuses payment. */
  maxAttempts?: number;
  /** Payment deadline from the first offer/pending response, in milliseconds. */
  timeoutMs?: number;
}

/** Client-side CEP-8 payment handlers, approval policy, and lifecycle limits. */
export interface ClientPaymentsOptions {
  /**
   * Payment handlers for in-band (programmatic) payment, indexed by their
   * {@link PaymentHandler.pmi}. Each handler's `pmi` is advertised to the
   * server so it can pick a matching rail (the wallet-client fast path).
   *
   * **Omit entirely** for a PMI-agnostic client that pays out-of-band: no PMIs
   * are advertised, so per CEP-8 the server sends `payment_required` for any of
   * its processors. The notification is forwarded to the application via
   * `onmessage`, synthetic progress keeps the original MCP request alive while
   * the payment settles out-of-band, and the server's TTL is the timeout.
   */
  handlers?: readonly PaymentHandler[];
  /** Optional limits across all automatic payment offers for one invocation. */
  limits?: ClientPaymentLimits;
  /**
   * Maximum distinct payment identities retained by this wrapper. Completed and
   * uncertain attempts are never evicted to make room for a new payment.
   * At capacity, new attempts fail without invoking a wallet. @default 1000
   * Explicit callbacks reserve every offered identity because option selection
   * is opaque; they must pay only one of the supplied options.
   */
  maxTrackedPaymentAttempts?: number;
  /**
   * Interval for periodic synthetic progress heartbeats (milliseconds).
   *
   * One heartbeat is also emitted immediately when `payment_required` is
   * received so the MCP timeout is always reset as soon as the payment flow
   * begins.
   * @default DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS (30_000 ms)
   */
  syntheticProgressIntervalMs?: number;
  /**
   * Duration in ms for synthetic progress when `payment_required` carries no `ttl`.
   *
   * Mirrors the server-side `paymentTtlMs` default so the client keeps the MCP
   * request alive for at least as long as the server will wait.
   * @default DEFAULT_PAYMENT_TTL_MS (300_000 ms)
   */
  defaultPaymentTtlMs?: number;
  /**
   * Minimum delay before an explicit-payment retry is re-sent
   * (milliseconds), applied after the server-provided `retry_after` backoff.
   *
   * Guards against `retry_after: 0`: an immediate retry within the same second
   * can produce a byte-identical Nostr event (same content, same tags, same
   * `created_at` at second resolution), which relays and servers swallow as a
   * duplicate — silently losing the retry.
   * Nostr transports always enforce at least 1000 ms, including paid retries.
   * Shorter delays are supported only by other transports.
   * @default 1000
   */
  minRetryDelayMs?: number;

  /**
   * Optional policy hook invoked when a `payment_required` notification is received.
   *
   * This is evaluated before checking rail-specific `canHandle` methods.
   *
   * When the underlying transport supports request correlation (e.g. {@link NostrClientTransport}),
   * `originalRequestContext` provides minimal details about the original JSON-RPC request that
   * triggered the payment.
   */
  paymentPolicy?: (
    req: PaymentHandlerRequest,
    originalRequestContext?: OriginalRequestContext,
  ) => boolean | Promise<boolean>;

  /** Requested payment interaction mode. @default 'transparent' */
  paymentInteraction?: PaymentInteractionMode;

  /**
   * Maximum number of -32043 (Payment Pending) retries before giving up.
   *
   * With retry_after=2 and 1.5× exponential backoff capped at 10s, the default
   * of 10 retries gives ~76s of cumulative wait — enough for typical verification
   * flows. Increase for slow payment processors (e.g. on-chain confirmation).
   * @default 10
   */
  maxPendingRetries?: number;

  /**
   * Handler for explicit-gating -32042 errors.
   * Called when a priced invocation returns Payment Required.
   * The handler should pay one option and signal completion.
   *
   * **Error handling contract**:
   * - If the promise resolves with `{ paid: true }`, the wrapper auto-retries the
   *   original request with the same `method` and `params`.
   * - If the promise resolves with `{ paid: false, reason }`, the wrapper synthesizes
   *   a JSON-RPC error to the caller with code `-32042` and `data: { reason }`.
   *   Use `reason: 'user_cancelled'` for user-initiated cancellations.
   * - If the promise **rejects**, the wrapper MUST NOT silently fall back.
   *   It synthesizes a JSON-RPC error with code `-32042` and
   *   `data: { reason: error.message, type: 'payment_handler_error' }`.
   * - Transient payment-provider failures should reject with an Error whose
   *   `message` contains the provider error details.
   *
   * **Verify-timeout window**: if the server's verification times out or fails
   * after the client paid, its pending state is cleared and the client's retry
   * can receive a fresh `-32042` with a new invoice. Distinct invoices still
   * pass through the invocation limits; an uncertain wallet outcome is terminal.
   */
  onPaymentRequired?: (params: {
    options: PaymentOption[];
    instructions?: string;
    originalRequest: JSONRPCRequest;
    /** Aborted on completion, cancellation, deadline, or close. Check before paying. */
    abortSignal: AbortSignal;
  }) => Promise<{ paid: boolean; reason?: string }>;
}
