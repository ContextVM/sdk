import { nip44 } from 'nostr-tools';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  NostrEvent,
} from 'nostr-tools/pure';
import {
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
  NOSTR_TAGS,
} from './constants.js';
import { NostrSigner } from './interfaces.js';

function isSupportedGiftWrapKind(kind: number): boolean {
  return kind === GIFT_WRAP_KIND || kind === EPHEMERAL_GIFT_WRAP_KIND;
}

/**
 * Encrypts a JSON-RPC message using a simplified NIP-17/NIP-59 gift wrap scheme.
 * The message is encrypted with NIP-44 and wrapped in a kind 1059 event.
 * @param message The JSON-RPC message to encrypt.
 * @param recipientPublicKey The public key of the recipient.
 * @returns The encrypted gift wrap event.
 */
export function encryptMessage(
  message: string,
  recipientPublicKey: string,
  giftWrapKind: number = GIFT_WRAP_KIND,
): NostrEvent {
  if (!isSupportedGiftWrapKind(giftWrapKind)) {
    throw new Error(`Unsupported gift wrap kind: ${giftWrapKind}`);
  }
  const giftWrapPrivateKey = generateSecretKey();
  const giftWrapPublicKey = getPublicKey(giftWrapPrivateKey);
  const conversationKey = nip44.v2.utils.getConversationKey(
    giftWrapPrivateKey,
    recipientPublicKey,
  );
  const encryptedContent = nip44.v2.encrypt(message, conversationKey);
  const giftWrap = {
    kind: giftWrapKind,
    content: encryptedContent,
    tags: [[NOSTR_TAGS.PUBKEY, recipientPublicKey]],
    created_at: Math.floor(Date.now() / 1000),
    pubkey: giftWrapPublicKey,
  };

  return finalizeEvent(giftWrap, giftWrapPrivateKey);
}

/**
 * Decrypts a gift-wrapped Nostr event using the signer's decryption methods.
 * @param event The gift wrap event (kind 1059).
 * @param signer The NostrSigner instance for decryption.
 * @returns The decrypted message content.
 * @throws If the event is not a valid gift wrap or decryption fails.
 */
export async function decryptMessage(
  event: NostrEvent,
  signer: NostrSigner,
): Promise<string> {
  if (!isSupportedGiftWrapKind(event.kind)) {
    throw new Error(`Event is not a supported gift wrap (kind=${event.kind}).`);
  }

  // Use the signer's nip44 decryption if available
  if (signer.nip44?.decrypt) {
    return await signer.nip44.decrypt(event.pubkey, event.content);
  }

  // If no nip44 support, throw an error since we can't access the private key directly
  throw new Error(
    'Signer does not support NIP-44 decryption. Please use a signer with nip44 support.',
  );
}
