import type { Filter, NostrEvent } from 'nostr-tools';
import { kinds, nip04 } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import type { RelayHandler } from '../../core/interfaces.js';
import { createLogger, type Logger } from '../../core/utils/logger.js';
import type { NwcConnection, NwcRequest, NwcResponse } from './types.js';
import { withTimeout } from '../../core/utils/utils.js';

export const NWC_INFO_KIND = kinds.NWCWalletInfo;
export const NWC_REQUEST_KIND = kinds.NWCWalletRequest;
export const NWC_RESPONSE_KIND = kinds.NWCWalletResponse;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getTagValue(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
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

  // RelayHandler only exposes a global `unsubscribe()`. To avoid cross-request
  // interference, we serialize NWC requests per client instance.
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
      const encryptedContent = await nip04.encrypt(
        this.connection.clientSecretKeyHex,
        this.connection.walletPubkey,
        plaintext,
      );

      const eventTemplate = {
        kind: NWC_REQUEST_KIND,
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
      } satisfies Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>;

      const signedRequest = finalizeEvent(eventTemplate, clientSecretKey);

      const responsePromise = new Promise<NostrEvent>((resolve, reject) => {
        const filters: Filter[] = [
          {
            kinds: [NWC_RESPONSE_KIND],
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
            resolve(event);
          })
          .catch(reject);
      });

      this.logger.debug('publish request', {
        method: params.method,
        requestId: signedRequest.id,
        encryption: 'nip04',
      });
      await this.relayHandler.publish(signedRequest);

      try {
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

        const decrypted = await nip04.decrypt(
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
        // Best-effort cleanup (RelayHandler has global unsubscribe).
        this.relayHandler.unsubscribe();
      }
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
