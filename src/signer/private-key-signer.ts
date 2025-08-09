import { hexToBytes } from '@noble/hashes/utils';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type NostrEvent,
  type UnsignedEvent,
} from 'nostr-tools';
import { NostrSigner } from '../core/interfaces.js';
import { nip44 } from 'nostr-tools';

/**
 * A signer that uses a private key to sign events.
 * @argument privateKey - The private key in HEX to use for signing.
 * @returns A signer that uses the provided private key to sign events.
 */
export class PrivateKeySigner implements NostrSigner {
  private readonly privateKey: Uint8Array;
  private readonly publicKey: string;

  constructor(privateKey?: string) {
    this.privateKey = privateKey ? hexToBytes(privateKey) : generateSecretKey();
    this.publicKey = getPublicKey(this.privateKey);
  }

  async getPublicKey(): Promise<string> {
    return this.publicKey;
  }

  async signEvent(event: UnsignedEvent): Promise<NostrEvent> {
    return finalizeEvent(event, this.privateKey);
  }

  /**
   * NIP-44 encryption and decryption implementation
   */
  nip44 = {
    encrypt: async (pubkey: string, plaintext: string): Promise<string> => {
      const conversationKey = nip44.v2.utils.getConversationKey(
        this.privateKey,
        pubkey,
      );
      return nip44.v2.encrypt(plaintext, conversationKey);
    },

    decrypt: async (pubkey: string, ciphertext: string): Promise<string> => {
      const conversationKey = nip44.v2.utils.getConversationKey(
        this.privateKey,
        pubkey,
      );
      return nip44.v2.decrypt(ciphertext, conversationKey);
    },
  };
}
