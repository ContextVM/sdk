import { type NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { type NostrSigner, GiftWrapMode } from '../../core/interfaces.js';
import { type LruCache } from '../../core/utils/lru-cache.js';
import { type Logger } from '../../core/utils/logger.js';
import {
  decryptMessage,
  DEFAULT_TIMEOUT_MS,
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
} from '../../core/index.js';
import { withTimeout } from '../../core/utils/utils.js';

/** Dependencies for the client-side event decryption and verification pipeline. */
export interface ClientEventPipelineDeps {
  signer: NostrSigner;
  seenEventIds: LruCache<true>;
  serverPubkey: string;
  giftWrapMode: GiftWrapMode;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/** Result of successfully unwrapping an inbound Nostr event on the client. */
export interface UnwrappedClientEvent {
  event: NostrEvent;
}

/** Handles gift-wrap decryption, signature verification, and server-pubkey gating for the client transport. */
export class ClientEventPipeline {
  constructor(private deps: ClientEventPipelineDeps) {}

  /**
   * Decrypts and verifies an inbound event, checking against the expected server pubkey.
   * Returns the inner event or null if invalid/duplicate.
   *
   * Deduplication is keyed on the outer event id (the gift-wrap envelope for
   * encrypted events, the bare event for unencrypted events) and applied before
   * any expensive decryption. Decrypted inner events are additionally
   * deduplicated by their own id as defense-in-depth against the same inner
   * request arriving in distinct envelopes. This mirrors the server pipeline.
   */
  public async unwrap(event: NostrEvent): Promise<UnwrappedClientEvent | null> {
    try {
      if (
        event.kind === GIFT_WRAP_KIND ||
        event.kind === EPHEMERAL_GIFT_WRAP_KIND
      ) {
        if (!this.isGiftWrapKindAllowed(event.kind)) {
          this.deps.logger.debug(
            'Skipping gift wrap due to GiftWrapMode policy',
            {
              eventId: event.id,
              kind: event.kind,
            },
          );
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

        return await this.handleEncryptedEvent(event);
      }
      return this.handleUnencryptedEvent(event);
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

  private async handleEncryptedEvent(
    event: NostrEvent,
  ): Promise<UnwrappedClientEvent | null> {
    try {
      const decryptedContent = await withTimeout(
        decryptMessage(event, this.deps.signer),
        DEFAULT_TIMEOUT_MS,
        'Decrypt message timed out',
      );
      const nostrEvent = JSON.parse(decryptedContent) as NostrEvent;

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

      // Deduplicate decrypted inner events before dispatch (defense-in-depth:
      // the same inner request may arrive in distinct gift-wrap envelopes).
      if (this.deps.seenEventIds.has(nostrEvent.id)) {
        this.deps.logger.debug('Skipping duplicate decrypted inner event', {
          outerEventId: event.id,
          innerEventId: nostrEvent.id,
        });
        return null;
      }
      this.deps.seenEventIds.set(nostrEvent.id, true);

      if (!this.isFromExpectedServer(nostrEvent)) return null;
      return { event: nostrEvent };
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

  private handleUnencryptedEvent(
    event: NostrEvent,
  ): UnwrappedClientEvent | null {
    // Deduplicate plain inbound deliveries before dispatch.
    if (this.deps.seenEventIds.has(event.id)) {
      this.deps.logger.debug('Skipping duplicate inbound event', {
        eventId: event.id,
      });
      return null;
    }
    this.deps.seenEventIds.set(event.id, true);

    if (!this.isFromExpectedServer(event)) return null;

    if (!verifyEvent(event)) {
      this.deps.logger.error(
        'Rejecting unencrypted event with invalid signature',
        {
          eventId: event.id,
          pubkey: event.pubkey,
        },
      );
      return null;
    }
    return { event };
  }

  /**
   * Returns true if the event's pubkey matches the expected server pubkey;
   * otherwise logs and returns false. Applies to both decrypted inner events
   * and unencrypted events.
   */
  private isFromExpectedServer(event: NostrEvent): boolean {
    if (event.pubkey === this.deps.serverPubkey) return true;
    this.deps.logger.debug('Skipping event from unexpected server pubkey:', {
      receivedPubkey: event.pubkey,
      expectedPubkey: this.deps.serverPubkey,
      eventId: event.id,
    });
    return false;
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
