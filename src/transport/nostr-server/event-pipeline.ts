import { type NostrEvent } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { type NostrSigner, EncryptionMode, GiftWrapMode } from '../../core/interfaces.js';
import { type LruCache } from '../../core/utils/lru-cache.js';
import { type Logger } from '../../core/utils/logger.js';
import { decryptMessage, DEFAULT_TIMEOUT_MS, EPHEMERAL_GIFT_WRAP_KIND, GIFT_WRAP_KIND } from '../../core/index.js';
import { withTimeout } from '../../core/utils/utils.js';

export interface ServerEventPipelineDeps {
  signer: NostrSigner;
  seenEventIds: LruCache<true>;
  encryptionMode: EncryptionMode;
  giftWrapMode: GiftWrapMode;
  logger: Logger;
  onerror?: (error: Error) => void;
}

export interface UnwrappedEvent {
  event: NostrEvent;
  isEncrypted: boolean;
  wrapKind?: number;
}

export class ServerEventPipeline {
  constructor(private deps: ServerEventPipelineDeps) {}

  /**
   * Decrypts and verifies an inbound event, returning the inner event or null if invalid/duplicate.
   */
  public async unwrap(event: NostrEvent): Promise<UnwrappedEvent | null> {
    try {
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

        return await this.handleEncryptedEvent(event);
      } else {
        return this.handleUnencryptedEvent(event);
      }
    } catch (error) {
      this.deps.logger.error('Error in event pipeline unwrap', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        eventKind: event.kind,
      });
      this.deps.onerror?.(error instanceof Error ? error : new Error(String(error)));
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

  private async handleEncryptedEvent(event: NostrEvent): Promise<UnwrappedEvent | null> {
    if (this.deps.encryptionMode === EncryptionMode.DISABLED) {
      this.deps.logger.error(
        `Received encrypted message from ${event.pubkey} but encryption is disabled. Ignoring.`,
      );
      return null;
    }
    try {
      const decryptedJson = await withTimeout(
        decryptMessage(event, this.deps.signer),
        DEFAULT_TIMEOUT_MS,
        'Decrypt message timed out',
      );
      const currentEvent = JSON.parse(decryptedJson) as NostrEvent;

      // Verify the inner event's cryptographic signature to prevent identity
      // forgery. Without this check an attacker can place any pubkey inside
      // the plaintext and bypass allowlists. (Fixes #64)
      if (!verifyEvent(currentEvent)) {
        this.deps.logger.error(
          'Rejecting decrypted inner event with invalid signature',
          {
            innerEventId: currentEvent.id,
            innerPubkey: currentEvent.pubkey,
            outerEventId: event.id,
          },
        );
        return null;
      }

      // Deduplicate decrypted inner events before authorization and dispatch.
      if (this.deps.seenEventIds.has(currentEvent.id)) {
        this.deps.logger.debug('Skipping duplicate decrypted inner event', {
          outerEventId: event.id,
          innerEventId: currentEvent.id,
        });
        return null;
      }
      this.deps.seenEventIds.set(currentEvent.id, true);

      return { event: currentEvent, isEncrypted: true, wrapKind: event.kind };
    } catch (error) {
      this.deps.logger.error('Failed to handle encrypted Nostr event', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
      });
      this.deps.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle encrypted Nostr event'),
      );
      return null;
    }
  }

  private handleUnencryptedEvent(event: NostrEvent): UnwrappedEvent | null {
    if (this.deps.encryptionMode === EncryptionMode.REQUIRED) {
      this.deps.logger.error(
        `Received unencrypted message from ${event.pubkey} but encryption is required. Ignoring.`,
      );
      return null;
    }
    if (!verifyEvent(event)) {
      this.deps.logger.error('Rejecting unencrypted event with invalid signature', {
        eventId: event.id,
        pubkey: event.pubkey,
      });
      return null;
    }
    return { event, isEncrypted: false };
  }
}
