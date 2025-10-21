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
import {
  createLogger,
  type LogLevel,
  type Logger,
} from '../core/utils/logger.js';

/**
 * Base options for configuring Nostr-based transports.
 */
export interface BaseNostrTransportOptions {
  signer: NostrSigner;
  relayHandler: RelayHandler;
  encryptionMode?: EncryptionMode;
  logLevel?: LogLevel;
}

/**
 * Base class for Nostr-based transports that provides common functionality
 * for managing Nostr connections, event conversion, and message handling.
 */
export abstract class BaseNostrTransport {
  private static readonly UNENCRYPTED_KINDS = new Set([
    SERVER_ANNOUNCEMENT_KIND,
    TOOLS_LIST_KIND,
    RESOURCES_LIST_KIND,
    RESOURCETEMPLATES_LIST_KIND,
    PROMPTS_LIST_KIND,
  ]);

  protected readonly signer: NostrSigner;
  protected readonly relayHandler: RelayHandler;
  protected readonly encryptionMode: EncryptionMode;
  protected logger: Logger;
  protected isConnected = false;

  constructor(module: string, options: BaseNostrTransportOptions) {
    this.signer = options.signer;
    this.relayHandler = options.relayHandler;
    this.encryptionMode = options.encryptionMode ?? EncryptionMode.OPTIONAL;
    this.logger = createLogger(module, { level: options.logLevel });
  }

  /**
   * Connects to the Nostr relay network.
   */
  protected async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await this.relayHandler.connect();
      this.isConnected = true;
      this.logger.info('Connected to Nostr relay network');
    } catch (error) {
      this.logAndRethrowError(
        'Failed to connect to Nostr relay network',
        error,
      );
    }
  }

  /**
   * Disconnects from the Nostr relay network.
   */
  protected async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.relayHandler.disconnect();
      this.isConnected = false;
      this.logger.info('Disconnected from Nostr relay network');
    } catch (error) {
      this.logAndRethrowError(
        'Failed to disconnect from Nostr relay network',
        error,
      );
    }
  }

  /**
   * Gets the public key from the signer.
   */
  protected async getPublicKey(): Promise<string> {
    try {
      return await this.signer.getPublicKey();
    } catch (error) {
      this.logAndRethrowError('Failed to get public key from signer', error);
    }
  }

  /**
   * Sets up a subscription to listen for Nostr events.
   */
  protected async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void | Promise<void>,
  ): Promise<void> {
    try {
      await this.relayHandler.subscribe(filters, async (event) => {
        try {
          await onEvent(event);
        } catch (error) {
          this.logger.error('Error in subscription event handler', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            eventId: event.id,
            eventKind: event.kind,
          });
          // Re-throw to allow the relay handler to handle it
          throw error;
        }
      });
      this.logger.debug('Subscribed to Nostr events', { filters });
    } catch (error) {
      this.logAndRethrowError('Failed to subscribe to Nostr events', error, {
        filters,
      });
    }
  }

  /**
   * Validates and converts a Nostr event to an MCP message.
   */
  protected convertNostrEventToMcpMessage(
    event: NostrEvent,
  ): JSONRPCMessage | null {
    try {
      // Early size validation (cheapest check first)
      if (!validateMessageSize(event.content)) {
        this.logger.warn('MCP message size validation failed', {
          eventId: event.id,
          pubkey: event.pubkey,
          contentSize: event.content.length,
        });
        return null;
      }

      // Convert and validate structure in one pass
      const message = nostrEventToMcpMessage(event);
      if (!message) {
        this.logger.debug(
          'Failed to convert Nostr event to MCP message - null result',
          {
            eventId: event.id,
            pubkey: event.pubkey,
          },
        );
        return null;
      }

      // Structural validation
      const validatedMessage = validateMessage(message);
      if (!validatedMessage) {
        this.logger.warn('Failed to validate MCP message structure', {
          eventId: event.id,
          pubkey: event.pubkey,
        });
        return null;
      }

      return validatedMessage;
    } catch (error) {
      this.logger.error('Error converting Nostr event to MCP message', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
      });
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
    try {
      const pubkey = await this.getPublicKey();
      const unsignedEvent = mcpToNostrEvent(message, pubkey, kind, tags);
      return await this.signer.signEvent(unsignedEvent);
    } catch (error) {
      this.logAndRethrowError('Failed to create signed Nostr event', error, {
        kind,
        hasTags: !!tags,
      });
    }
  }

  /**
   * Publishes a signed Nostr event to the relay network.
   */
  protected async publishEvent(event: NostrEvent): Promise<void> {
    try {
      await this.relayHandler.publish(event);
      this.logger.debug('Published Nostr event', {
        eventId: event.id,
        kind: event.kind,
      });
    } catch (error) {
      this.logAndRethrowError('Failed to publish Nostr event', error, {
        eventId: event.id,
        kind: event.kind,
      });
    }
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
    try {
      const shouldEncrypt = this.shouldEncryptMessage(kind, isEncrypted);

      const event = await this.createSignedNostrEvent(message, kind, tags);

      if (shouldEncrypt) {
        const encryptedEvent = encryptMessage(
          JSON.stringify(event),
          recipientPublicKey,
        );
        await this.publishEvent(encryptedEvent);
        this.logger.debug('Sent encrypted MCP message', {
          eventId: event.id,
          kind,
          recipient: recipientPublicKey,
        });
      } else {
        await this.publishEvent(event);
        this.logger.debug('Sent unencrypted MCP message', {
          eventId: event.id,
          kind,
          recipient: recipientPublicKey,
        });
      }
      return event.id;
    } catch (error) {
      this.logAndRethrowError('Failed to send MCP message', error, {
        kind,
        recipient: recipientPublicKey,
        encryptionMode: this.encryptionMode,
      });
    }
  }

  /**
   * Determines whether a message should be encrypted based on kind and encryption mode.
   */
  private shouldEncryptMessage(kind: number, isEncrypted?: boolean): boolean {
    // Check if kind should never be encrypted
    if (BaseNostrTransport.UNENCRYPTED_KINDS.has(kind)) {
      return false;
    }

    // Apply encryption mode rules
    switch (this.encryptionMode) {
      case EncryptionMode.DISABLED:
        return false;
      case EncryptionMode.REQUIRED:
        return true;
      case EncryptionMode.OPTIONAL:
        return isEncrypted ?? true;
      default:
        return true; // Safe default
    }
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

  /**
   * Logs an error and re-throws it for consistent error handling.
   */
  private logAndRethrowError(
    context: string,
    error: unknown,
    metadata?: Record<string, unknown>,
  ): never {
    this.logger.error(context, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...metadata,
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
}
