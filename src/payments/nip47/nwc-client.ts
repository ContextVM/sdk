import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';
import { kinds, nip04 } from 'nostr-tools';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import type { RelayHandler } from '../../core/interfaces.js';
import { createLogger, type Logger } from '../../core/utils/logger.js';
import type {
  NwcConnection,
  NwcNotificationPayload,
  NwcRequest,
  NwcResponse,
} from './types.js';
import { subscribePaymentEvents } from '../payment-subscription.js';
import { queryTags } from '../../core/utils/utils.js';
import {
  paymentOperation,
  type PaymentOperationContext,
} from '../payment-cancellation.js';

// Per NIP-47.
export const NWC_NOTIFICATION_KIND = 23197;
export const NWC_NOTIFICATION_LEGACY_KIND = 23196;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface NwcClientOptions {
  relayHandler: RelayHandler;
  connection: NwcConnection;
  /** Disconnect the relay only when this client owns it. @default false */
  ownsRelayHandler?: boolean;

  /** How long to wait for a single NIP-47 response. @default 60_000 */
  responseTimeoutMs?: number;
}

/**
 * Minimal NIP-47 client for request/response over relays.
 *
 * Policy: use `nip04` for encryption/decryption.
 *
 * Rationale: many real-world NWC wallets still use NIP-04; keep this client minimal and
 * consistent with the working reference implementation.
 */
export class NwcClient {
  private readonly relayHandler: RelayHandler;
  private readonly connection: NwcConnection;
  private readonly responseTimeoutMs: number;
  private readonly logger: Logger;
  private connected = false;
  private readonly shutdown = new AbortController();
  private readonly subscriptions = new Set<() => void>();
  private readonly ownsRelayHandler: boolean;
  private connecting?: Promise<void>;

  // NIP-47 is request/response over relays. To avoid cross-request interference,
  // we serialize NWC requests per client instance.
  private requestQueue: Promise<void> = Promise.resolve();

  public constructor(options: NwcClientOptions) {
    this.relayHandler = options.relayHandler;
    this.ownsRelayHandler = options.ownsRelayHandler ?? false;
    this.connection = options.connection;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 60_000;
    this.logger = createLogger('payments/nwc');
  }

  public async connect(): Promise<void> {
    if (this.shutdown.signal.aborted) throw new Error('NWC client is closed');
    if (this.connected) return;
    if (!this.connecting)
      this.connecting = this.relayHandler
        .connect()
        .then(async () => {
          if (this.shutdown.signal.aborted && this.ownsRelayHandler)
            await this.relayHandler.disconnect();
          else if (!this.shutdown.signal.aborted) this.connected = true;
        })
        .finally(() => {
          this.connecting = undefined;
        });
    await this.connecting;
  }

  public async fetchInfoNotificationTypes(
    context: PaymentOperationContext = {},
  ): Promise<ReadonlySet<string>> {
    const operation = paymentOperation(
      context,
      this.responseTimeoutMs,
      this.shutdown.signal,
    );
    try {
      await operation.wait(this.connect());

      const promise = new Promise<ReadonlySet<string>>((resolve, reject) => {
        const filters: Filter[] = [
          {
            kinds: [kinds.NWCWalletInfo],
            authors: [this.connection.walletPubkey],
            limit: 1,
          },
        ];

        void subscribePaymentEvents(
          this.relayHandler,
          filters,
          operation.signal,
          (event) => {
            if (
              event.kind !== kinds.NWCWalletInfo ||
              event.pubkey !== this.connection.walletPubkey ||
              !verifyEvent(event)
            )
              return;
            const tags = event.tags as string[][];
            const raw = queryTags(tags, 'notifications').allValues.join(' ');
            const types = raw
              .split(/\s+/)
              .map((t) => t.trim())
              .filter(Boolean);
            resolve(new Set(types));
          },
          () => resolve(new Set()),
        ).catch(reject);
      });

      return await operation.wait(promise);
    } finally {
      operation.dispose();
    }
  }

  public async subscribeNotifications(params: {
    onNotification: (payload: NwcNotificationPayload) => void;
    abortSignal?: AbortSignal;
  }): Promise<() => void> {
    const operation = paymentOperation(
      params,
      this.responseTimeoutMs,
      this.shutdown.signal,
    );
    let stopped = false;
    let release: (() => void) | undefined;
    const unsubscribe = (): void => {
      stopped = true;
      release?.();
      release = undefined;
      this.subscriptions.delete(unsubscribe);
      params.abortSignal?.removeEventListener('abort', unsubscribe);
    };
    params.abortSignal?.addEventListener('abort', unsubscribe, { once: true });
    this.subscriptions.add(unsubscribe);
    try {
      await operation.wait(this.connect());

      const clientPubkey = getPublicKey(
        hexToBytes(this.connection.clientSecretKeyHex),
      );

      const filters: Filter[] = [
        {
          kinds: [NWC_NOTIFICATION_KIND, NWC_NOTIFICATION_LEGACY_KIND],
          '#p': [clientPubkey],
          authors: [this.connection.walletPubkey],
          since: nowSeconds() - 5,
        },
      ];

      this.logger.debug('subscribe for notifications', { filters });

      const subscription = this.relayHandler.subscribe(filters, (event) => {
        if (
          stopped ||
          event.pubkey !== this.connection.walletPubkey ||
          !verifyEvent(event) ||
          !event.tags.some((t) => t[0] === 'p' && t[1] === clientPubkey)
        )
          return;
        try {
          const decrypted = nip04.decrypt(
            this.connection.clientSecretKeyHex,
            event.pubkey,
            event.content,
          );
          const parsed = JSON.parse(decrypted) as NwcNotificationPayload;
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof parsed.notification_type !== 'string'
          ) {
            return;
          }
          params.onNotification(parsed);
        } catch (error: unknown) {
          this.logger.debug('failed to decrypt/parse nwc notification', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      void subscription.then(
        (u) => {
          release = u;
          if (stopped || this.shutdown.signal.aborted) unsubscribe();
        },
        () => {},
      );
      await operation.wait(subscription);
      return unsubscribe;
    } catch (error) {
      unsubscribe();
      throw error;
    } finally {
      operation.dispose();
    }
  }

  /** Stops this client's work without closing a caller-owned relay pool. */
  public async disconnect(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort();
    for (const unsubscribe of [...this.subscriptions]) unsubscribe();
    if (this.ownsRelayHandler) {
      await this.relayHandler.disconnect();
    }
    this.connected = false;
  }

  public async request<M extends string, P, R>(params: {
    method: M;
    request: NwcRequest<M, P>;
    resultType: M;
    responseResultGuard?: (result: unknown) => result is R;
    expirationSeconds?: number;
    abortSignal?: AbortSignal;
    deadlineMs?: number;
  }): Promise<NwcResponse<M, R>> {
    const operation = paymentOperation(
      params,
      this.responseTimeoutMs,
      this.shutdown.signal,
    );
    const prev = this.requestQueue;
    let release!: () => void;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await operation.wait(prev);
      operation.signal.throwIfAborted();
      const now = nowSeconds();
      await operation.wait(this.connect());

      const clientSecretKey = hexToBytes(this.connection.clientSecretKeyHex);

      const plaintext = JSON.stringify(params.request);
      const encryptedContent = nip04.encrypt(
        this.connection.clientSecretKeyHex,
        this.connection.walletPubkey,
        plaintext,
      );

      const eventTemplate = {
        kind: kinds.NWCWalletRequest,
        created_at: now,
        content: encryptedContent,
        tags: [
          ['p', this.connection.walletPubkey],
          // NOTE: Historically, NWC has used NIP-04 and many implementations do not require this tag.
          // Keeping it to aid wallet-side debugging.
          ['encryption', 'nip04'],
          ...(params.expirationSeconds
            ? [['expiration', String(params.expirationSeconds)]]
            : []),
        ],
      } satisfies EventTemplate;

      const signedRequest = finalizeEvent(eventTemplate, clientSecretKey);

      let subscribed!: Promise<void>;
      const responsePromise = new Promise<NostrEvent>((resolve, reject) => {
        const filters: Filter[] = [
          {
            kinds: [kinds.NWCWalletResponse],
            '#e': [signedRequest.id],
            authors: [this.connection.walletPubkey],
            since: now - 5,
          },
        ];

        this.logger.debug('subscribe for response', {
          method: params.method,
          requestId: signedRequest.id,
          filters,
        });

        subscribed = subscribePaymentEvents(
          this.relayHandler,
          filters,
          operation.signal,
          (event) => {
            if (
              operation.signal.aborted ||
              event.kind !== kinds.NWCWalletResponse ||
              event.pubkey !== this.connection.walletPubkey ||
              !verifyEvent(event) ||
              queryTags(event.tags, 'e').firstValue !== signedRequest.id
            )
              return;
            this.logger.debug('received response event', {
              method: params.method,
              requestId: signedRequest.id,
              eventId: event.id,
              pubkey: event.pubkey,
            });
            resolve(event);
          },
        );
        void subscribed.catch(reject);
      });

      this.logger.debug('publish request', {
        method: params.method,
        requestId: signedRequest.id,
        encryption: 'nip04',
      });
      void responsePromise.catch(() => {});
      await operation.wait(subscribed);
      operation.signal.throwIfAborted();
      await operation.wait(
        this.relayHandler.publish(signedRequest, {
          abortSignal: operation.signal,
        }),
      );
      const responseEvent = await operation.wait(responsePromise);

      const decrypted = nip04.decrypt(
        this.connection.clientSecretKeyHex,
        responseEvent.pubkey,
        responseEvent.content,
      );

      const parsed = JSON.parse(decrypted) as NwcResponse<M, unknown>;

      if (parsed.result_type !== params.resultType) {
        throw new Error(
          `Unexpected NWC result_type: ${String(parsed.result_type)} (expected ${params.resultType})`,
        );
      }

      if (parsed.error) {
        return parsed as NwcResponse<M, R>;
      }

      if (params.responseResultGuard && parsed.result !== null) {
        if (!params.responseResultGuard(parsed.result)) {
          throw new Error('Unexpected NWC result shape');
        }
      }

      return parsed as NwcResponse<M, R>;
    } finally {
      operation.dispose();
      // Keep queued operations serialized even when this caller leaves the queue early.
      void prev.finally(() => release?.());
    }
  }
}
