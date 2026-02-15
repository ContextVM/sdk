import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';
import { kinds, nip04 } from 'nostr-tools';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import type { RelayHandler } from '../../core/interfaces.js';
import { createLogger, type Logger } from '../../core/utils/logger.js';
import type {
  NwcConnection,
  NwcNotificationPayload,
  NwcRequest,
  NwcResponse,
} from './types.js';
import {
  getTagValue,
  getTagValues,
  withTimeout,
} from '../../core/utils/utils.js';

// Per NIP-47.
export const NWC_NOTIFICATION_KIND = 23197;
export const NWC_NOTIFICATION_LEGACY_KIND = 23196;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export interface NwcClientOptions {
  relayHandler: RelayHandler;
  connection: NwcConnection;

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

  // NIP-47 is request/response over relays. To avoid cross-request interference,
  // we serialize NWC requests per client instance.
  private requestQueue: Promise<void> = Promise.resolve();

  public constructor(options: NwcClientOptions) {
    this.relayHandler = options.relayHandler;
    this.connection = options.connection;
    this.responseTimeoutMs = options.responseTimeoutMs ?? 60_000;
    this.logger = createLogger('payments/nwc');
  }

  public async connect(): Promise<void> {
    if (this.connected) return;
    await this.relayHandler.connect();
    this.connected = true;
  }

  public async fetchInfoNotificationTypes(): Promise<ReadonlySet<string>> {
    await this.connect();

    let unsubscribe: (() => void) | undefined;
    let settled = false;

    const promise = new Promise<ReadonlySet<string>>((resolve, reject) => {
      const filters: Filter[] = [
        {
          kinds: [kinds.NWCWalletInfo],
          authors: [this.connection.walletPubkey],
          limit: 1,
        },
      ];

      void this.relayHandler
        .subscribe(
          filters,
          (event) => {
            settled = true;
            const tags = event.tags as string[][];
            const raw = getTagValues(tags, 'notifications').join(' ');
            const types = raw
              .split(/\s+/)
              .map((t) => t.trim())
              .filter(Boolean);
            resolve(new Set(types));
          },
          () => {
            if (settled) return;
            settled = true;
            resolve(new Set());
          },
        )
        .then((u) => {
          unsubscribe = u;
          if (settled) unsubscribe();
        })
        .catch((error: unknown) => {
          settled = true;
          reject(error);
        });
    });

    promise.finally(() => unsubscribe?.());

    return await withTimeout(
      promise,
      this.responseTimeoutMs,
      'NWC info event fetch timed out',
    );
  }

  public async subscribeNotifications(params: {
    onNotification: (payload: NwcNotificationPayload) => void;
  }): Promise<() => void> {
    await this.connect();

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

    const unsubscribe = await this.relayHandler.subscribe(filters, (event) => {
      void (async () => {
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
      })();
    });

    return unsubscribe;
  }

  public async disconnect(): Promise<void> {
    this.relayHandler.unsubscribe();
    if (!this.connected) return;
    await this.relayHandler.disconnect();
    this.connected = false;
  }

  public async request<M extends string, P, R>(params: {
    method: M;
    request: NwcRequest<M, P>;
    resultType: M;
    responseResultGuard?: (result: unknown) => result is R;
    expirationSeconds?: number;
  }): Promise<NwcResponse<M, R>> {
    const now = nowSeconds();

    const run = async (): Promise<NwcResponse<M, R>> => {
      await this.connect();

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

      let settled = false;
      let unsubscribeResponse: (() => void) | undefined;

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

        void this.relayHandler
          .subscribe(filters, (event) => {
            this.logger.debug('received response event', {
              method: params.method,
              requestId: signedRequest.id,
              eventId: event.id,
              pubkey: event.pubkey,
            });
            settled = true;
            resolve(event);
          })
          .then((unsubscribe) => {
            // Ensure the subscription is cleaned up when the promise settles.
            unsubscribeResponse = unsubscribe;
            if (settled) {
              unsubscribeResponse();
            }
          })
          .catch((error: unknown) => {
            settled = true;
            reject(error);
          });
      });

      // Also cleanup on timeout/error paths.
      responsePromise.finally(() => unsubscribeResponse?.());

      this.logger.debug('publish request', {
        method: params.method,
        requestId: signedRequest.id,
        encryption: 'nip04',
      });
      const publishController = new AbortController();
      const publishTimeout = setTimeout(
        () => publishController.abort(),
        this.responseTimeoutMs,
      );
      try {
        await this.relayHandler.publish(signedRequest, {
          abortSignal: publishController.signal,
        });
      } finally {
        clearTimeout(publishTimeout);
      }

      if (publishController.signal.aborted) {
        throw new Error(`NWC publish timed out for ${params.method}`);
      }

      const responseEvent = await withTimeout(
        responsePromise,
        this.responseTimeoutMs,
        `NWC response timed out for ${params.method}`,
      );

      // Validate correlation.
      const eTag = getTagValue(responseEvent.tags as string[][], 'e');
      if (eTag !== signedRequest.id) {
        throw new Error('NWC response did not correlate to request');
      }

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
    };

    const prev = this.requestQueue;
    let release: (() => void) | undefined;
    this.requestQueue = new Promise<void>((r) => {
      release = r;
    });

    await prev;
    try {
      return await run();
    } finally {
      release?.();
    }
  }
}
