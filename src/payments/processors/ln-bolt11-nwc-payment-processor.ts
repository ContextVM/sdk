import type { RelayHandler } from '../../core/interfaces.js';
import type {
  PaymentProcessor,
  PaymentProcessorCreateParams,
  PaymentProcessorVerifyParams,
  PaymentRequired,
} from '../types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';
import { parseNwcConnectionString } from '../nip47/connection.js';
import { NwcClient } from '../nip47/nwc-client.js';
import type {
  NwcConnection,
  NwcInvoiceResult,
  NwcNotificationPayload,
  NwcResponse,
} from '../nip47/types.js';
import { ApplesauceRelayPool } from '../../relay/applesauce-relay-pool.js';
import { satsToMsats } from '../nip47/utils.js';
import { LruCache } from '../../core/utils/lru-cache.js';
import {
  paymentOperation,
  type PaymentOperationContext,
} from '../payment-cancellation.js';
export interface NwcClientLike {
  request<M extends string, P, R>(params: {
    method: M;
    request: { method: M; params: P };
    resultType: M;
    abortSignal?: AbortSignal;
    deadlineMs?: number;
  }): Promise<NwcResponse<M, R>>;
  disconnect?(): Promise<void>;
  fetchInfoNotificationTypes(
    context?: PaymentOperationContext,
  ): Promise<ReadonlySet<string>>;
  subscribeNotifications(params: {
    onNotification: (payload: NwcNotificationPayload) => void;
    abortSignal?: AbortSignal;
  }): Promise<() => void>;
}

export interface LnBolt11NwcPaymentProcessorOptions {
  /** NIP-47 `nostr+walletconnect://...` connection string. */
  nwcConnectionString: string;
  /** Optional pre-parsed connection for tests or advanced integrations. */
  connection?: NwcConnection;
  /** Optional relay handler to reuse; defaults to an ApplesauceRelayPool built from the connection relays. */
  relayHandler?: RelayHandler;
  /** Optional injected NWC client for tests or custom transports. */
  nwcClient?: NwcClientLike;

  /** Fallback TTL in seconds if wallet does not provide expires_at. @default 300 */
  ttlSeconds?: number;
  /** `make_invoice.expiry` in seconds. @default ttlSeconds */
  invoiceExpirySeconds?: number;
  /** Poll interval for `lookup_invoice`. @default 1500 */
  pollIntervalMs?: number;
  /** Per-request response timeout. @default 60_000 */
  responseTimeoutMs?: number;

  /**
   * Controls whether payment verification uses NWC notifications.
   *
   * - `false`: always poll using `lookup_invoice`.
   * - `true`: verify using `payment_received` wakeups plus authenticated lookup fallback.
   * - `undefined` (default): best-effort auto-detect on first use via the wallet's info event.
   */
  enableNotificationVerification?: boolean;

  /**
   * Maximum number of in-flight invoice verifications to dedupe.
   *
   * This is a scalability and relay-load guardrail.
   * @default 5000
   */
  maxInFlightVerifications?: number;

  /**
   * Maximum number of invoice->payment_hash mappings to cache.
   *
   * This reduces the need to rely on invoice-string lookups when wallets support payment_hash.
   * @default 10000
   */
  invoiceHashCacheSize?: number;
}

/** NWC settlement lookup with one shared notification subscription used as a wakeup hint. */
export class LnBolt11NwcPaymentProcessor implements PaymentProcessor {
  public readonly currencyUnit = 'sats';
  public readonly pmi = PMI_BITCOIN_LIGHTNING_BOLT11;
  private readonly nwc: NwcClientLike;
  private readonly ownedClient: boolean;
  private readonly shutdown = new AbortController();
  private readonly invoiceHashCache: LruCache<string>;
  private readonly receipts: LruCache<boolean>;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly active = new Map<
    string,
    {
      promise: Promise<{ _meta?: Record<string, unknown> }>;
      controller: AbortController;
      users: number;
    }
  >();
  private subscription?: Promise<void>;
  private unsubscribe?: () => void;
  private initialization?: Promise<void>;
  private notificationEnabled: boolean;
  private readonly ttlSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly responseTimeoutMs: number;
  private readonly invoiceExpirySeconds: number;
  private readonly maxActive: number;

  public constructor(options: LnBolt11NwcPaymentProcessorOptions) {
    const connection =
      options.connection ??
      parseNwcConnectionString(options.nwcConnectionString);
    this.ownedClient = !options.nwcClient;
    this.nwc =
      options.nwcClient ??
      new NwcClient({
        relayHandler:
          options.relayHandler ??
          new ApplesauceRelayPool([...connection.relays]),
        ownsRelayHandler: !options.relayHandler,
        connection,
        responseTimeoutMs: options.responseTimeoutMs,
      });
    this.ttlSeconds = options.ttlSeconds ?? 300;
    this.invoiceExpirySeconds = options.invoiceExpirySeconds ?? this.ttlSeconds;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 60_000;
    this.maxActive = options.maxInFlightVerifications ?? 5000;
    for (const value of [
      this.ttlSeconds,
      this.invoiceExpirySeconds,
      this.pollIntervalMs,
      this.responseTimeoutMs,
      this.maxActive,
      options.invoiceHashCacheSize ?? 10000,
    ]) {
      if (!Number.isFinite(value) || value <= 0)
        throw new TypeError('NWC limits must be positive and finite');
    }
    this.invoiceHashCache = new LruCache(options.invoiceHashCacheSize ?? 10000);
    this.receipts = new LruCache(options.invoiceHashCacheSize ?? 10000);
    this.notificationEnabled = options.enableNotificationVerification ?? false;
    if (options.enableNotificationVerification === undefined) {
      const operation = paymentOperation(
        {},
        this.responseTimeoutMs,
        this.shutdown.signal,
      );
      this.initialization = operation
        .wait(
          this.nwc.fetchInfoNotificationTypes({
            abortSignal: operation.signal,
          }),
        )
        .then((types) => {
          this.notificationEnabled = types.has('payment_received');
        })
        .catch(() => {})
        .finally(() => operation.dispose());
    }
  }

  private ensureSubscription(): Promise<void> {
    if (
      !this.notificationEnabled ||
      this.unsubscribe ||
      this.shutdown.signal.aborted
    )
      return Promise.resolve();
    if (!this.subscription) {
      const operation = paymentOperation(
        {},
        this.responseTimeoutMs,
        this.shutdown.signal,
      );
      const pending = this.nwc.subscribeNotifications({
        abortSignal: this.shutdown.signal,
        onNotification: (payload) => {
          if (
            this.shutdown.signal.aborted ||
            payload.notification_type !== 'payment_received'
          )
            return;
          const hash = (payload.notification as { payment_hash?: unknown })
            ?.payment_hash;
          if (typeof hash !== 'string' || !hash) return;
          this.receipts.set(hash, true);
          for (const wake of this.waiters.get(hash) ?? []) wake();
        },
      });
      let abandoned = false;
      void pending.then(
        (u) => {
          if (abandoned || this.shutdown.signal.aborted) u();
          else this.unsubscribe = u;
        },
        () => {},
      );
      this.subscription = operation
        .wait(pending)
        .then(() => {})
        .catch(() => {
          abandoned = true;
        })
        .finally(() => {
          operation.dispose();
          this.subscription = undefined;
        });
    }
    return this.subscription;
  }

  /** Creates one invoice; a cancelled request can still have created it remotely. */
  public async createPaymentRequired(
    params: PaymentProcessorCreateParams,
  ): Promise<PaymentRequired> {
    const operation = paymentOperation(
      params,
      this.responseTimeoutMs,
      this.shutdown.signal,
    );
    try {
      operation.signal.throwIfAborted();
      const response = await operation.wait(
        this.nwc.request({
          method: 'make_invoice',
          resultType: 'make_invoice',
          abortSignal: operation.signal,
          request: {
            method: 'make_invoice',
            params: {
              amount: satsToMsats(params.amount),
              description: params.description,
              expiry: this.invoiceExpirySeconds,
            },
          },
        }),
      );
      if (response.error)
        throw new Error(`NWC make_invoice failed: ${response.error.code}`);
      const result = response.result as NwcInvoiceResult | null;
      if (!result?.invoice)
        throw new Error('NWC make_invoice returned no invoice');
      if (result.payment_hash)
        this.invoiceHashCache.set(result.invoice, result.payment_hash);
      return {
        amount: params.amount,
        pay_req: result.invoice,
        pmi: this.pmi,
        description: params.description,
        ttl: this.ttlSeconds,
      };
    } finally {
      operation.dispose();
    }
  }

  /** Shares provider work while each caller retains independent cancellation. */
  public async verifyPayment(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    const caller = paymentOperation(
      params,
      this.ttlSeconds * 1000,
      this.shutdown.signal,
    );
    let entry = this.active.get(params.pay_req);
    let joined = false;
    try {
      caller.signal.throwIfAborted();
      if (!entry) {
        if (this.active.size >= this.maxActive)
          throw new Error('NWC verification capacity reached');
        const controller = new AbortController();
        const current = {
          controller,
          users: 0,
          promise: Promise.resolve({}) as Promise<{
            _meta?: Record<string, unknown>;
          }>,
        };
        entry = current;
        this.active.set(params.pay_req, current);
        current.promise = this.verifyInternal({
          ...params,
          deadlineMs: undefined,
          abortSignal: controller.signal,
        }).finally(() => {
          if (this.active.get(params.pay_req) === current)
            this.active.delete(params.pay_req);
        });
      }
      entry.users++;
      joined = true;
      return await caller.wait(entry.promise);
    } finally {
      caller.dispose();
      if (joined && entry && --entry.users === 0) entry.controller.abort();
    }
  }

  private async verifyInternal(
    params: PaymentProcessorVerifyParams,
  ): Promise<{ _meta?: Record<string, unknown> }> {
    const operation = paymentOperation(
      params,
      this.ttlSeconds * 1000,
      this.shutdown.signal,
    );
    try {
      // Lookup begins even if info/subscription setup stalls. Notifications only accelerate it.
      void this.initialization?.then(() => this.ensureSubscription());
      void this.ensureSubscription();
      while (true) {
        operation.signal.throwIfAborted();
        const hash = this.invoiceHashCache.get(params.pay_req);
        let wake!: () => void;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hint = new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (hash) {
          const set = this.waiters.get(hash) ?? new Set();
          set.add(wake);
          this.waiters.set(hash, set);
          if (this.receipts.get(hash)) {
            this.receipts.delete(hash);
            wake();
          }
        }
        try {
          let response:
            NwcResponse<'lookup_invoice', NwcInvoiceResult> | undefined;
          const request = paymentOperation(
            { abortSignal: operation.signal },
            this.responseTimeoutMs,
          );
          try {
            response = await request.wait(
              this.nwc.request({
                method: 'lookup_invoice',
                resultType: 'lookup_invoice',
                abortSignal: request.signal,
                request: {
                  method: 'lookup_invoice',
                  params: hash
                    ? { payment_hash: hash }
                    : { invoice: params.pay_req },
                },
              }),
            );
          } catch {
            operation.signal.throwIfAborted();
          } finally {
            request.dispose();
          }
          if (
            response?.error &&
            ['UNAUTHORIZED', 'RESTRICTED', 'NOT_IMPLEMENTED'].includes(
              response.error.code,
            )
          )
            throw new Error(
              `NWC lookup_invoice failed: ${response.error.code}`,
            );
          const result = response?.result;
          if (result?.payment_hash && hash && result.payment_hash !== hash)
            throw new Error('NWC lookup invoice hash mismatch');
          if (result?.invoice && result.invoice !== params.pay_req)
            throw new Error('NWC lookup invoice mismatch');
          if (result?.type === 'outgoing')
            throw new Error('NWC lookup is not a receiver invoice');
          if (result?.payment_hash)
            this.invoiceHashCache.set(params.pay_req, result.payment_hash);
          if (
            !response?.error &&
            (result?.state === 'settled' ||
              (typeof result?.settled_at === 'number' && result.settled_at > 0))
          ) {
            return {
              _meta: {
                payment_hash:
                  result.payment_hash ?? `settled:${params.requestEventId}`,
              },
            };
          }
          // Even an expired invoice can settle late. Only authenticated settlement completes verification.
          timer = setTimeout(wake, this.pollIntervalMs);
          await operation.wait(hint);
        } finally {
          clearTimeout(timer);
          if (hash) {
            const set = this.waiters.get(hash);
            set?.delete(wake);
            if (!set?.size) this.waiters.delete(hash);
          }
        }
      }
    } finally {
      operation.dispose();
    }
  }

  /** Stops verifications/subscriptions; injected clients and relay pools stay usable. */
  public async dispose(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const entry of this.active.values()) entry.controller.abort();
    this.waiters.clear();
    this.invoiceHashCache.clear();
    this.receipts.clear();
    if (this.ownedClient) await this.nwc.disconnect?.();
  }
}
