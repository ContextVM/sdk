import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Filter, NostrEvent } from 'nostr-tools';
import {
  EncryptionMode,
  NostrSigner,
  RelayHandler,
} from '../core/interfaces.js';
import {
  CTXVM_MESSAGES_KIND,
  GIFT_WRAP_KIND,
  mcpToNostrEvent,
  NOSTR_TAGS,
  nostrEventToMcpMessage,
  encryptMessage,
  SERVER_ANNOUNCEMENT_KIND,
  TOOLS_LIST_KIND,
  RESOURCES_LIST_KIND,
  RESOURCETEMPLATES_LIST_KIND,
  PROMPTS_LIST_KIND,
} from '../core/index.js';
import { validateMessage, validateMessageSize } from '../core/utils/utils.js';

// TODO: Add proper shutdown handling https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#shutdown

/**
 * Base options for configuring Nostr-based transports.
 */
export interface BaseNostrTransportOptions {
  signer: NostrSigner;
  relayHandler: RelayHandler;
  encryptionMode?: EncryptionMode;
}

/**
 * Base class for Nostr-based transports that provides common functionality
 * for managing Nostr connections, event conversion, and message handling.
 */
export abstract class BaseNostrTransport {
  protected readonly signer: NostrSigner;
  protected readonly relayHandler: RelayHandler;
  protected readonly encryptionMode: EncryptionMode;
  protected isConnected = false;

  constructor(options: BaseNostrTransportOptions) {
    this.signer = options.signer;
    this.relayHandler = options.relayHandler;
    this.encryptionMode = options.encryptionMode ?? EncryptionMode.OPTIONAL;
  }

  /**
   * Connects to the Nostr relay network.
   */
  protected async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    await this.relayHandler.connect();
    this.isConnected = true;
  }

  /**
   * Disconnects from the Nostr relay network.
   */
  protected async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    await this.relayHandler.disconnect();
    this.isConnected = false;
  }

  /**
   * Gets the public key from the signer.
   */
  protected async getPublicKey(): Promise<string> {
    return await this.signer.getPublicKey();
  }

  /**
   * Sets up a subscription to listen for Nostr events.
   */
  protected async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void | Promise<void>,
  ): Promise<void> {
    await this.relayHandler.subscribe(filters, onEvent);
  }

  /**
   * Validates and converts a Nostr event to an MCP message.
   */
  protected convertNostrEventToMcpMessage(
    event: NostrEvent,
  ): JSONRPCMessage | null {
    try {
      const message = nostrEventToMcpMessage(event);
      if (!message) {
        return null;
      }

      // Validate message structure
      const validatedMessage = validateMessage(message);
      if (!validatedMessage) {
        return null;
      }

      // Validate message size
      if (!validateMessageSize(event.content)) {
        return null;
      }

      return validatedMessage;
    } catch {
      return null;
    }
  }

  /**
   * Converts an MCP message to a Nostr event and signs it.
   */
  protected async createSignedNostrEvent(
    message: JSONRPCMessage,
    kind: number,
    tags?: NostrEvent['tags'],
  ): Promise<NostrEvent> {
    const pubkey = await this.getPublicKey();
    const unsignedEvent = mcpToNostrEvent(message, pubkey, kind, tags);
    return await this.signer.signEvent(unsignedEvent);
  }

  /**
   * Publishes a signed Nostr event to the relay network.
   */
  protected async publishEvent(event: NostrEvent): Promise<void> {
    await this.relayHandler.publish(event);
  }

  /**
   * Creates and publishes a Nostr event for an MCP message.
   */
  protected async sendMcpMessage(
    message: JSONRPCMessage,
    recipientPublicKey: string,
    kind: number,
    tags?: NostrEvent['tags'],
    isEncrypted?: boolean,
  ): Promise<string> {
    const unencryptedKinds = [
      SERVER_ANNOUNCEMENT_KIND,
      TOOLS_LIST_KIND,
      RESOURCES_LIST_KIND,
      RESOURCETEMPLATES_LIST_KIND,
      PROMPTS_LIST_KIND,
    ];

    let shouldEncrypt: boolean = true;
    if (unencryptedKinds.includes(kind)) {
      shouldEncrypt = false;
    } else {
      if (this.encryptionMode === EncryptionMode.OPTIONAL) {
        shouldEncrypt = isEncrypted ?? true;
      } else if (this.encryptionMode === EncryptionMode.DISABLED) {
        shouldEncrypt = false;
      } else if (this.encryptionMode === EncryptionMode.REQUIRED) {
        shouldEncrypt = true;
      }
    }

    const event = await this.createSignedNostrEvent(message, kind, tags);

    if (shouldEncrypt) {
      const encryptedEvent = encryptMessage(
        JSON.stringify(event),
        recipientPublicKey,
      );
      await this.publishEvent(encryptedEvent);
    } else {
      await this.publishEvent(event);
    }
    return event.id;
  }

  /**
   * Creates subscription filters for listening to messages targeting a specific pubkey.
   */
  protected createSubscriptionFilters(
    targetPubkey: string,
    additionalFilters: Partial<Filter> = {},
  ): Filter[] {
    return [
      {
        '#p': [targetPubkey],
        kinds: [CTXVM_MESSAGES_KIND, GIFT_WRAP_KIND],
        since: Math.floor(Date.now() / 1000),
        ...additionalFilters,
      },
    ];
  }

  /**
   * Creates tags for targeting a specific recipient.
   */
  protected createRecipientTags(recipientPubkey: string): NostrEvent['tags'] {
    const tags = [[NOSTR_TAGS.PUBKEY, recipientPubkey]];
    return tags;
  }

  /**
   * Creates tags for responding to a specific event.
   */
  protected createResponseTags(
    recipientPubkey: string,
    originalEventId: string,
  ): NostrEvent['tags'] {
    const tags = [
      [NOSTR_TAGS.PUBKEY, recipientPubkey],
      [NOSTR_TAGS.EVENT_ID, originalEventId],
    ];
    return tags;
  }
}
