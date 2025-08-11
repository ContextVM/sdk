import {
  ListPromptsRequest,
  ListResourcesRequest,
  ListResourceTemplatesRequest,
  ListToolsRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { EventTemplate, Filter, NostrEvent } from 'nostr-tools';

/**
 * Defines the encryption mode for the transport.
 * - `optional`: Encrypts messages if the incoming message was encrypted.
 * - `required`: Enforces encryption for all messages.
 * - `disabled`: Disables encryption entirely.
 */
export enum EncryptionMode {
  OPTIONAL = 'optional',
  REQUIRED = 'required',
  DISABLED = 'disabled',
}

/**
 * A generic interface for Nostr signers.
 */
export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;

  // Optional NIP-04 encryption support (deprecated)
  nip04?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };

  // Optional NIP-44 encryption support
  nip44?: {
    encrypt: (pubkey: string, plaintext: string) => Promise<string>;
    decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
  };
}

/**
 * A generic interface for Nostr relays.
 */
export interface RelayHandler {
  connect(): Promise<void>;
  disconnect(relayUrls?: string[]): Promise<void>;
  publish(event: NostrEvent): Promise<void>;
  subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): Promise<void>;
  unsubscribe(): void;
}

export interface AnnouncementMethods {
  tools: ListToolsRequest['method'];
  resources: ListResourcesRequest['method'];
  resourceTemplates: ListResourceTemplatesRequest['method'];
  prompts: ListPromptsRequest['method'];
}
