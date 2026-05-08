import { type NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { type NostrSigner, GiftWrapMode } from '../../core/interfaces.js';
import { type LruCache } from '../../core/utils/lru-cache.js';
import { type Logger } from '../../core/utils/logger.js';
import { decryptMessage, DEFAULT_TIMEOUT_MS, EPHEMERAL_GIFT_WRAP_KIND, GIFT_WRAP_KIND } from '../../core/index.js';
import { withTimeout } from '../../core/utils/utils.js';

export interface ClientEventPipelineDeps {
  signer: NostrSigner;
  seenEventIds: LruCache<string, true>;
  serverPubkey: string;
  giftWrapMode: GiftWrapMode;
  logger: Logger;
  onerror?: (error: Error) => void;
}

export interface UnwrappedClientEvent {
  event: NostrEvent;
}

export class ClientEventPipeline {
  constructor(private deps: ClientEventPipelineDeps) {}

  /**
   * Decrypts and verifies an inbound event, checking against the expected server pubkey.
   * Returns the inner event or null if invalid/duplicate.
   */
  public async unwrap(event: NostrEvent): Promise<UnwrappedClientEvent | null> {
    try {
      let nostrEvent = event;

      if (
        event.kind === GIFT_WRAP_KIND ||
        event.kind === EPHEMERAL_GIFT_WRAP_KIND
      ) {
        if (!this.isGiftWrapKindAllowed(event.kind)) {
          this.deps.logger.debug('Skipping gift wrap due to GiftWrapMode policy', {
            eventId: event.id,
            kind: event.kind,
          });
          return null;
        }

        // Deduplicate gift-wrap envelopes before any expensive decryption.
        if (this.deps.seenEventIds.has(event.id)) {
          this.deps.logger.debug('Skipping duplicate gift-wrapped event', {
            eventId: event.id,
          });
          return null;
        }
        this.deps.seenEventIds.set(event.id, true);

        try {
          const decryptedContent = await withTimeout(
            decryptMessage(event, this.deps.signer),
            DEFAULT_TIMEOUT_MS,
            'Decrypt message timed out',
          );
          nostrEvent = JSON.parse(decryptedContent) as NostrEvent;

          // Verify the inner event's cryptographic signature to prevent
          // identity forgery. Without this check an attacker can place the
          // server's pubkey inside the plaintext and spoof responses. (Fixes #64)
          if (!verifyEvent(nostrEvent)) {
            this.deps.logger.error(
              'Rejecting decrypted inner event with invalid signature',
              {
                innerEventId: nostrEvent.id,
                innerPubkey: nostrEvent.pubkey,
                outerEventId: event.id,
              },
            );
            return null;
          }
        } catch (decryptError) {
          this.deps.logger.error('Failed to decrypt gift-wrapped event', {
            error:
              decryptError instanceof Error
                ? decryptError.message
                : String(decryptError),
            stack:
              decryptError instanceof Error ? decryptError.stack : undefined,
            eventId: event.id,
            pubkey: event.pubkey,
          });
          this.deps.onerror?.(
            decryptError instanceof Error
              ? decryptError
              : new Error('Failed to decrypt gift-wrapped event'),
          );
          return null;
        }
      }

      if (nostrEvent.pubkey !== this.deps.serverPubkey) {
        this.deps.logger.debug('Skipping event from unexpected server pubkey:', {
          receivedPubkey: nostrEvent.pubkey,
          expectedPubkey: this.deps.serverPubkey,
          eventId: nostrEvent.id,
        });
        return null;
      }

      if (
        event.kind !== GIFT_WRAP_KIND &&
        event.kind !== EPHEMERAL_GIFT_WRAP_KIND
      ) {
        if (!verifyEvent(nostrEvent)) {
          this.deps.logger.error(
            'Rejecting unencrypted event with invalid signature',
            {
              eventId: nostrEvent.id,
              pubkey: nostrEvent.pubkey,
            },
          );
          return null;
        }
      }

      return { event: nostrEvent };
    } catch (error) {
      this.deps.logger.error('Error in event pipeline unwrap (client)', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
      });
      this.deps.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle incoming Nostr event'),
      );
      return null;
    }
  }

  private isGiftWrapKindAllowed(kind: number): boolean {
    if (this.deps.giftWrapMode === GiftWrapMode.PERSISTENT) {
      return kind === GIFT_WRAP_KIND;
    }
    if (this.deps.giftWrapMode === GiftWrapMode.EPHEMERAL) {
      return kind === EPHEMERAL_GIFT_WRAP_KIND;
    }
    return true;
  }
}
