import {
  InitializeResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  NotificationSchema,
  type JSONRPCMessage,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  type JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CTXVM_MESSAGES_KIND,
  DEFAULT_TIMEOUT_MS,
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
  decryptMessage,
  DEFAULT_LRU_SIZE,
  INITIALIZE_METHOD,
  NOSTR_TAGS,
} from '../core/index.js';
import { LruCache } from '../core/utils/lru-cache.js';
import {
  BaseNostrTransport,
  BaseNostrTransportOptions,
} from './base-nostr-transport.js';
import { getNostrEventTag } from '../core/utils/serializers.js';
import { NostrEvent } from 'nostr-tools';
import { LogLevel } from '../core/utils/logger.js';
import { GiftWrapMode } from '../core/interfaces.js';
import {
  ClientCorrelationStore,
  PendingRequest,
  type OriginalRequestContext,
} from './nostr-client/correlation-store.js';
import { StatelessModeHandler } from './nostr-client/stateless-mode-handler.js';
import { withTimeout } from '../core/utils/utils.js';

function hasSingleTag(tags: string[][], tag: string): boolean {
  return tags.some((t) => t.length === 1 && t[0] === tag);
}

/**
 * Options for configuring the NostrClientTransport.
 */
export interface NostrTransportOptions extends BaseNostrTransportOptions {
  /** The server's public key for targeting messages */
  serverPubkey: string;
  /** Whether to operate in stateless mode (emulates server responses) */
  isStateless?: boolean;
  /** Log level for the transport */
  logLevel?: LogLevel;
}

/**
 * A client transport layer for CTXVM that uses Nostr events for communication.
 * Implements the Transport interface from the @modelcontextprotocol/sdk.
 * Handles request/response correlation and optional stateless mode emulation.
 */
export class NostrClientTransport
  extends BaseNostrTransport
  implements Transport
{
  /** Public event handlers required by the Transport interface */
  public onmessage?: (message: JSONRPCMessage) => void;
  public onmessageWithContext:
    | ((
        message: JSONRPCMessage,
        ctx: { eventId: string; correlatedEventId?: string },
      ) => void)
    | undefined = undefined;
  public onclose?: () => void;
  public onerror?: (error: Error) => void;

  /** The server's public key for message targeting */
  private readonly serverPubkey: string;
  /** Manages request/response correlation for pending requests */
  private readonly correlationStore: ClientCorrelationStore;
  /** Handles stateless mode emulation for public servers */
  private readonly statelessHandler: StatelessModeHandler;
  /** Whether stateless mode is enabled */
  private readonly isStateless: boolean;
  /** Optional list of client-supported PMIs (ordered by preference). */
  private clientPmis: readonly string[] | undefined;
  /** The server's initialize event, if received */
  private serverInitializeEvent: NostrEvent | undefined;

  /** The latest server tools/list response event envelope, if received. */
  private serverToolsListEvent: NostrEvent | undefined;
  /** The latest server prompts/list response event envelope, if received. */
  private serverPromptsListEvent: NostrEvent | undefined;
  /** The latest server resources/list response event envelope, if received. */
  private serverResourcesListEvent: NostrEvent | undefined;
  /** The latest server resources/templates/list response event envelope, if received. */
  private serverResourceTemplatesListEvent: NostrEvent | undefined;

  /**
   * Deduplicate inbound events to avoid redundant work.
   *
   * Used for gift-wrap envelopes (outer event ids). Kept as a bounded LRU.
   */
  private readonly seenEventIds = new LruCache<true>(DEFAULT_LRU_SIZE);

  /**
   * Creates a new NostrClientTransport instance.
   * @param options - Configuration options for the transport
   * @throws Error if serverPubkey is not a valid hex public key
   */
  constructor(options: NostrTransportOptions) {
    super('nostr-client-transport', options);

    // Validate serverPubkey is valid hex
    if (!/^[0-9a-f]{64}$/i.test(options.serverPubkey)) {
      throw new Error(`Invalid serverPubkey format: ${options.serverPubkey}`);
    }

    this.serverPubkey = options.serverPubkey;
    this.isStateless = options.isStateless ?? false;
    this.correlationStore = new ClientCorrelationStore({
      maxPendingRequests: DEFAULT_LRU_SIZE,
      onRequestEvicted: (eventId) => {
        this.logger.debug('Evicted pending request', { eventId });
      },
    });
    this.statelessHandler = new StatelessModeHandler();
  }

  /**
   * Sets the client PMI preference list used for CEP-8 discovery/negotiation.
   *
   * Intended to be called by payments wrappers (e.g. `withClientPayments()`).
   */
  public setClientPmis(pmis: readonly string[]): void {
    this.clientPmis = pmis;
  }

  /**
   * Starts the transport, connecting to the relay and setting up event listeners.
   */
  public async start(): Promise<void> {
    try {
      // Execute independent async operations in parallel
      const [_connectionResult, pubkey] = await Promise.all([
        this.connect(),
        this.getPublicKey(),
      ]);
      this.logger.info('Client pubkey:', pubkey);
      const filters = this.createSubscriptionFilters(pubkey);

      await this.subscribe(filters, async (event) => {
        try {
          await this.processIncomingEvent(event);
        } catch (error) {
          this.logger.error('Error processing incoming event', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            eventId: event.id,
          });
          this.onerror?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.logAndRethrowError('Error starting NostrClientTransport', error);
    }
  }

  /**
   * Closes the transport, disconnecting from the relay and clearing state.
   */
  public async close(): Promise<void> {
    try {
      await this.taskQueue.shutdown();
      this.unsubscribeAll();
      await this.disconnect();
      this.correlationStore.clear();
      this.seenEventIds.clear();
      this.onclose?.();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.logAndRethrowError('Error closing NostrClientTransport', error);
    }
  }

  /**
   * Sends a JSON-RPC message over the Nostr transport.
   * Handles stateless mode emulation for initialize requests.
   * @param message - The JSON-RPC request or notification to send
   */
  public async send(message: JSONRPCMessage): Promise<void> {
    try {
      if (
        this.isStateless &&
        this.statelessHandler.shouldHandleStatelessly(message)
      ) {
        if (isJSONRPCRequest(message) && message.method === INITIALIZE_METHOD) {
          this.logger.info('Stateless mode: Emulating initialize response.');
          this.emulateInitializeResponse(message.id as string | number);
          return;
        }
        return;
      }

      await this.sendRequest(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.logAndRethrowError('Error sending message', error, {
        messageType: isJSONRPCRequest(message)
          ? 'request'
          : isJSONRPCNotification(message)
            ? 'notification'
            : 'unknown',
        method:
          isJSONRPCRequest(message) || isJSONRPCNotification(message)
            ? message.method
            : undefined,
      });
    }
  }

  /**
   * Sends a request and registers it for correlation tracking.
   * @param message - The JSON-RPC message to send
   * @returns The ID of the published Nostr event
   */
  private async sendRequest(message: JSONRPCMessage): Promise<string> {
    const isRequest = isJSONRPCRequest(message);

    const pmiTags: string[][] =
      isRequest && this.clientPmis
        ? this.clientPmis.map((pmi) => ['pmi', pmi] as string[])
        : [];

    const tags = [...this.createRecipientTags(this.serverPubkey), ...pmiTags];

    const giftWrapKind = this.chooseOutboundGiftWrapKind();

    return await this.sendMcpMessage(
      message,
      this.serverPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      undefined,
      (eventId) => {
        const progressToken = isRequest
          ? message.params?._meta?.progressToken
          : undefined;
        const originalRequestContext = isRequest
          ? this.getOriginalRequestContext(message)
          : undefined;
        this.correlationStore.registerRequest(eventId, {
          originalRequestId: isRequest ? message.id : null,
          isInitialize: isRequest && message.method === INITIALIZE_METHOD,
          progressToken:
            progressToken !== undefined ? String(progressToken) : undefined,
          originalRequestContext,
        });
      },
      giftWrapKind,
    );
  }

  private chooseOutboundGiftWrapKind(): number {
    // Strict modes are deterministic.
    if (this.giftWrapMode === GiftWrapMode.PERSISTENT) return GIFT_WRAP_KIND;
    if (this.giftWrapMode === GiftWrapMode.EPHEMERAL)
      return EPHEMERAL_GIFT_WRAP_KIND;

    const initTags = this.serverInitializeEvent?.tags;
    const supportsEphemeral =
      Array.isArray(initTags) &&
      hasSingleTag(
        initTags as string[][],
        NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
      );

    return supportsEphemeral ? EPHEMERAL_GIFT_WRAP_KIND : GIFT_WRAP_KIND;
  }

  private getOriginalRequestContext(
    message: JSONRPCMessage,
  ): OriginalRequestContext | undefined {
    if (!isJSONRPCRequest(message)) return undefined;

    const method = message.method;

    switch (method) {
      case 'tools/call': {
        const name = message.params?.name;
        if (typeof name !== 'string' || name.length === 0) {
          return { method };
        }
        return { method, capability: `tool:${name}` };
      }
      case 'prompts/get': {
        const name = message.params?.name;
        if (typeof name !== 'string' || name.length === 0) {
          return { method };
        }
        return { method, capability: `prompt:${name}` };
      }
      case 'resources/read': {
        const uri = message.params?.uri;
        if (typeof uri !== 'string' || uri.length === 0) {
          return { method };
        }
        return { method, capability: `resource:${uri}` };
      }
      default:
        return { method };
    }
  }

  /**
   * Internal helper used by payments middleware to correlate CEP-8 notifications
   * (e.g. payment_required) to the original request's progress token.
   * @internal
   */
  public getPendingRequestForEventId(
    eventId: string,
  ): PendingRequest | undefined {
    return this.correlationStore.getPendingRequest(eventId);
  }

  /**
   * Emulates the server's initialize response for stateless clients.
   * @param requestId - The ID of the original initialize request
   */
  private emulateInitializeResponse(requestId: string | number): void {
    const response = this.statelessHandler.createEmulatedResponse(requestId);

    queueMicrotask(() => {
      try {
        this.onmessage?.(response);
      } catch (error) {
        this.logger.error('Error in emulated initialize response callback', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          requestId,
        });
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }

  /**
   * Processes incoming Nostr events, routing them to the correct handler.
   * @param event - The incoming Nostr event
   */
  private async processIncomingEvent(event: NostrEvent): Promise<void> {
    try {
      let nostrEvent = event;

      if (
        event.kind === GIFT_WRAP_KIND ||
        event.kind === EPHEMERAL_GIFT_WRAP_KIND
      ) {
        if (!this.isGiftWrapKindAllowed(event.kind)) {
          this.logger.debug('Skipping gift wrap due to GiftWrapMode policy', {
            eventId: event.id,
            kind: event.kind,
          });
          return;
        }

        // Deduplicate gift-wrap envelopes before any expensive decryption.
        if (this.seenEventIds.has(event.id)) {
          this.logger.debug('Skipping duplicate gift-wrapped event', {
            eventId: event.id,
          });
          return;
        }
        this.seenEventIds.set(event.id, true);

        try {
          const decryptedContent = await withTimeout(
            decryptMessage(event, this.signer),
            DEFAULT_TIMEOUT_MS,
            'Decrypt message timed out',
          );
          nostrEvent = JSON.parse(decryptedContent) as NostrEvent;
        } catch (decryptError) {
          this.logger.error('Failed to decrypt gift-wrapped event', {
            error:
              decryptError instanceof Error
                ? decryptError.message
                : String(decryptError),
            stack:
              decryptError instanceof Error ? decryptError.stack : undefined,
            eventId: event.id,
            pubkey: event.pubkey,
          });
          this.onerror?.(
            decryptError instanceof Error
              ? decryptError
              : new Error('Failed to decrypt gift-wrapped event'),
          );
          return;
        }
      }

      if (nostrEvent.pubkey !== this.serverPubkey) {
        this.logger.debug('Skipping event from unexpected server pubkey:', {
          receivedPubkey: nostrEvent.pubkey,
          expectedPubkey: this.serverPubkey,
          eventId: nostrEvent.id,
        });
        return;
      }

      const eTag = getNostrEventTag(nostrEvent.tags, 'e');

      if (!this.serverInitializeEvent && eTag) {
        try {
          const content = JSON.parse(nostrEvent.content);
          const parse = InitializeResultSchema.safeParse(content.result);
          if (parse.success) {
            this.serverInitializeEvent = nostrEvent;
            this.logger.info('Received server initialize event', {
              eventId: nostrEvent.id,
            });
          }
        } catch {
          this.logger.debug('Event is not a valid initialize response', {
            eventId: nostrEvent.id,
          });
        }
      }

      const mcpMessage = this.convertNostrEventToMcpMessage(nostrEvent);

      if (!mcpMessage) {
        this.logger.error(
          'Skipping invalid Nostr event with malformed JSON content',
          { eventId: nostrEvent.id, pubkey: nostrEvent.pubkey },
        );
        return;
      }

      // Message classification MUST be based on JSON-RPC type, not on the presence of an `e` tag.
      // CEP-8 notifications are correlated (include `e`) but are still notifications.
      if (
        isJSONRPCResultResponse(mcpMessage) ||
        isJSONRPCErrorResponse(mcpMessage)
      ) {
        if (!eTag) {
          this.logger.warn(
            'Received JSON-RPC response without correlation `e` tag',
            {
              eventId: nostrEvent.id,
            },
          );
          return;
        }

        if (!this.correlationStore.hasPendingRequest(eTag)) {
          this.logger.warn('Received response for unknown/expired request', {
            eventId: nostrEvent.id,
            eTag,
            reason:
              'Request not found in pending set - may be duplicate or late response',
          });
          return;
        }

        // Capture outer Nostr event envelope for capability list JSON-RPC responses.
        // This allows consumers to inspect Nostr tags (e.g. CEP-8 `cap` tags)
        // that are not present in the JSON-RPC payload.
        if (isJSONRPCResultResponse(mcpMessage)) {
          const result = mcpMessage.result;
          if (ListToolsResultSchema.safeParse(result).success) {
            this.serverToolsListEvent = nostrEvent;
          } else if (ListResourcesResultSchema.safeParse(result).success) {
            this.serverResourcesListEvent = nostrEvent;
          } else if (
            ListResourceTemplatesResultSchema.safeParse(result).success
          ) {
            this.serverResourceTemplatesListEvent = nostrEvent;
          } else if (ListPromptsResultSchema.safeParse(result).success) {
            this.serverPromptsListEvent = nostrEvent;
          }
        }

        this.handleResponse(eTag, mcpMessage);
        return;
      }

      if (isJSONRPCNotification(mcpMessage)) {
        this.handleNotification(nostrEvent.id, eTag ?? undefined, mcpMessage);
        return;
      }

      this.logger.warn('Received unsupported JSON-RPC message type', {
        eventId: nostrEvent.id,
        hasETag: !!eTag,
      });
    } catch (error) {
      this.logger.error('Error handling incoming Nostr event', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
      });
      this.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle incoming Nostr event'),
      );
    }
  }

  /**
   * Gets the server's initialize event if received.
   * @returns The server initialize event or undefined
   */
  public getServerInitializeEvent(): NostrEvent | undefined {
    return this.serverInitializeEvent;
  }

  /** Gets the server's most recently observed tools/list event envelope, if any. */
  public getServerToolsListEvent(): NostrEvent | undefined {
    return this.serverToolsListEvent;
  }

  /** Gets the server's most recently observed resources/list event envelope, if any. */
  public getServerResourcesListEvent(): NostrEvent | undefined {
    return this.serverResourcesListEvent;
  }

  /** Gets the server's most recently observed resources/templates/list event envelope, if any. */
  public getServerResourceTemplatesListEvent(): NostrEvent | undefined {
    return this.serverResourceTemplatesListEvent;
  }

  /** Gets the server's most recently observed prompts/list event envelope, if any. */
  public getServerPromptsListEvent(): NostrEvent | undefined {
    return this.serverPromptsListEvent;
  }

  /**
   * Handles response messages by correlating them with pending requests.
   * @param correlatedEventId - The Nostr event ID used for correlation
   * @param mcpMessage - The JSON-RPC response message
   */
  private handleResponse(
    correlatedEventId: string,
    mcpMessage: JSONRPCMessage,
  ): void {
    try {
      const resolved = this.correlationStore.resolveResponse(
        correlatedEventId,
        mcpMessage as JSONRPCResponse,
      );

      if (resolved) {
        this.onmessage?.(mcpMessage);
      } else {
        this.logger.warn('Response for unknown request', {
          eventId: correlatedEventId,
        });
      }
    } catch (error) {
      this.logger.error('Error handling response', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        correlatedEventId,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handles notification messages by validating and forwarding them.
   * @param mcpMessage - The JSON-RPC notification message
   */
  private handleNotification(
    eventId: string,
    correlatedEventId: string | undefined,
    mcpMessage: JSONRPCMessage,
  ): void {
    try {
      const result = NotificationSchema.safeParse(mcpMessage);
      if (!result.success) {
        this.logger.warn('Invalid notification schema', {
          issues: result.error.issues,
          message: mcpMessage,
        });
        return;
      }
      this.onmessage?.(mcpMessage);
      this.onmessageWithContext?.(mcpMessage, {
        eventId,
        correlatedEventId,
      });
    } catch (error) {
      this.logger.error('Failed to handle incoming notification', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle incoming notification'),
      );
    }
  }

  /**
   * Test-only accessor for internal state.
   * @internal
   */
  getInternalStateForTesting() {
    return {
      correlationStore: this.correlationStore,
      statelessHandler: this.statelessHandler,
      serverInitializeEvent: this.serverInitializeEvent,
      serverToolsListEvent: this.serverToolsListEvent,
      serverResourcesListEvent: this.serverResourcesListEvent,
      serverResourceTemplatesListEvent: this.serverResourceTemplatesListEvent,
      serverPromptsListEvent: this.serverPromptsListEvent,
    };
  }
}
