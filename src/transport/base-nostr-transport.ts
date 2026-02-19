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
import { validateMessage, withTimeout } from '../core/utils/utils.js';
import {
  createLogger,
  type LogLevel,
  type Logger,
} from '../core/utils/logger.js';
import { TaskQueue } from '../core/utils/task-queue.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';

// Default timeout for network operations (30 seconds)
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Base options for configuring Nostr-based transports.
 */
// TODO: We could improve the ergonomics of this and simplify the signer creation, it can accept a NostrSigner instance or an string defaulting to a private key signer
export interface BaseNostrTransportOptions {
  signer: NostrSigner;
  relayHandler: RelayHandler | string[];
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

  protected readonly taskQueue: TaskQueue;

  // Transport-level subscription ownership.
  // Even if the relay handler supports global unsubscribe/disconnect, transports
  // should explicitly release the specific subscription(s) they create.
  private readonly subscriptionUnsubscribers = new Set<() => void>();

  constructor(module: string, options: BaseNostrTransportOptions) {
    this.signer = options.signer;
    this.relayHandler = Array.isArray(options.relayHandler)
      ? new ApplesauceRelayPool(options.relayHandler)
      : options.relayHandler;
    this.encryptionMode = options.encryptionMode ?? EncryptionMode.OPTIONAL;
    this.logger = createLogger(module, { level: options.logLevel });
    this.taskQueue = new TaskQueue(5);
  }

  /**
   * Connects to the Nostr relay network.
   */
  protected async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      await withTimeout(
        this.relayHandler.connect(),
        DEFAULT_TIMEOUT_MS,
        'Connection to Nostr relay network timed out',
      );
      this.isConnected = true;
      this.logger.info(
        'Connected to Nostr relays',
        this.relayHandler.getRelayUrls?.() ?? '',
      );
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
      await withTimeout(
        this.relayHandler.disconnect(),
        DEFAULT_TIMEOUT_MS,
        'Disconnection from Nostr relay network timed out',
      );
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
      return await withTimeout(
        this.signer.getPublicKey(),
        DEFAULT_TIMEOUT_MS,
        'Get public key timed out',
      );
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
      const unsubscribe = await this.relayHandler.subscribe(
        filters,
        (event) => {
          this.taskQueue.add(async () => {
            try {
              await onEvent(event);
            } catch (error) {
              this.logger.error('Error in subscription event handler', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                eventId: event.id,
                eventKind: event.kind,
              });
            }
          });
        },
      );

      this.subscriptionUnsubscribers.add(unsubscribe);
      this.logger.debug('Subscribed to Nostr events', { filters });
    } catch (error) {
      this.logAndRethrowError('Failed to subscribe to Nostr events', error, {
        filters,
      });
    }
  }

  /**
   * Unsubscribes all transport-owned relay subscriptions.
   *
   * This is intentionally separate from relay disconnect: unsubscribing stops
   * inbound message processing immediately, while allowing the relay handler to
   * manage socket teardown independently.
   */
  protected unsubscribeAll(): void {
    for (const unsubscribe of this.subscriptionUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // best-effort
      }
    }
    this.subscriptionUnsubscribers.clear();
  }

  /**
   * Validates and converts a Nostr event to an MCP message.
   */
  protected convertNostrEventToMcpMessage(
    event: NostrEvent,
  ): JSONRPCMessage | null {
    try {
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
      return await withTimeout(
        this.signer.signEvent(unsignedEvent),
        DEFAULT_TIMEOUT_MS,
        'Sign event timed out',
      );
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
      const controller = new AbortController();
      try {
        await withTimeout(
          this.relayHandler.publish(event, {
            abortSignal: controller.signal,
          }),
          DEFAULT_TIMEOUT_MS,
          'Publish event timed out',
        );
      } finally {
        controller.abort();
      }
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
   * @param onEventCreated Optional callback invoked with the inner event ID before publishing.
   * This allows callers to register the event ID before the actual publish occurs,
   * preventing race conditions in multi-relay setups where responses may arrive
   * before the publish operation completes.
   */
  protected async sendMcpMessage(
    message: JSONRPCMessage,
    recipientPublicKey: string,
    kind: number,
    tags?: NostrEvent['tags'],
    isEncrypted?: boolean,
    onEventCreated?: (eventId: string) => void,
  ): Promise<string> {
    try {
      const shouldEncrypt = this.shouldEncryptMessage(kind, isEncrypted);

      const event = await this.createSignedNostrEvent(message, kind, tags);

      // Allow caller to register the event ID before publishing
      onEventCreated?.(event.id);

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
  protected logAndRethrowError(
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
