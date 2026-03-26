import {
  InitializeResult,
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
  DEFAULT_BOOTSTRAP_RELAY_URLS,
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
import { parseServerIdentity } from './nostr-client/server-identity.js';
import {
  fetchServerRelayList,
  selectOperationalRelayUrls,
} from './nostr-client/server-relay-discovery.js';
import { StatelessModeHandler } from './nostr-client/stateless-mode-handler.js';
import { withTimeout } from '../core/utils/utils.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';

function hasSingleTag(tags: string[][], tag: string): boolean {
  return tags.some((t) => t.length === 1 && t[0] === tag);
}

function hasEventTag(event: NostrEvent | undefined, tag: string): boolean {
  return (
    Array.isArray(event?.tags) && hasSingleTag(event.tags as string[][], tag)
  );
}

function hasKnownDiscoveryTag(event: NostrEvent | undefined): boolean {
  if (!event || !Array.isArray(event.tags)) {
    return false;
  }

  const knownDiscoveryTags = new Set<string>([
    NOSTR_TAGS.NAME,
    NOSTR_TAGS.ABOUT,
    NOSTR_TAGS.WEBSITE,
    NOSTR_TAGS.PICTURE,
    NOSTR_TAGS.SUPPORT_ENCRYPTION,
    NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
  ]);

  return event.tags.some((tag) => knownDiscoveryTags.has(tag[0] ?? ''));
}

/**
 * Options for configuring the NostrClientTransport.
 */
export interface NostrTransportOptions extends Omit<
  BaseNostrTransportOptions,
  'relayHandler'
> {
  /** The server's identity for targeting messages. Accepts hex pubkey, npub, or nprofile. */
  serverPubkey: string;
  /**
   * Optional operational relays to use immediately.
   * When omitted, the client resolves relays from identity hints or CEP-17 discovery.
   */
  relayHandler?: BaseNostrTransportOptions['relayHandler'];
  /**
   * Relay URLs used only for relay-list discovery when operational relays are not configured.
   * Overrides the default bootstrap discovery relays when provided.
   */
  discoveryRelayUrls?: string[];
  /**
   * Non-authoritative operational relays that may be used when discovery is unresolved.
   * These are probed in parallel with CEP-17 discovery when no explicit relays or hints exist.
   */
  fallbackOperationalRelayUrls?: string[];
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
  /** Relay hints extracted from the provided server identity. */
  private readonly hintedRelayUrls: readonly string[];
  /** Relay URLs used for CEP-17 discovery when no operational relays are configured. */
  private readonly discoveryRelayUrls: readonly string[];
  /** Optional non-authoritative operational relays used as a fast fallback. */
  private readonly fallbackOperationalRelayUrls: readonly string[];
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

  /** Whether the server has advertised ephemeral gift wrap support via Nostr tags. */
  private serverSupportsEphemeralGiftWraps: boolean = false;

  /**
   * Deduplicate inbound events to avoid redundant work.
   *
   * Used for gift-wrap envelopes (outer event ids). Kept as a bounded LRU.
   */
  private readonly seenEventIds = new LruCache<true>(DEFAULT_LRU_SIZE);

  /**
   * Creates a new NostrClientTransport instance.
   * @param options - Configuration options for the transport
   * @throws Error if serverPubkey is not a valid supported server identifier
   */
  constructor(options: NostrTransportOptions) {
    super('nostr-client-transport', {
      ...options,
      relayHandler: options.relayHandler ?? [],
    });

    const parsedServerIdentity = parseServerIdentity(options.serverPubkey);

    this.serverPubkey = parsedServerIdentity.pubkey;
    this.hintedRelayUrls = parsedServerIdentity.relayUrls;
    this.discoveryRelayUrls =
      options.discoveryRelayUrls ?? DEFAULT_BOOTSTRAP_RELAY_URLS;
    this.fallbackOperationalRelayUrls =
      options.fallbackOperationalRelayUrls ?? [];
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
      await this.resolveOperationalRelayHandler();

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

    if (this.serverSupportsEphemeralGiftWraps) {
      return EPHEMERAL_GIFT_WRAP_KIND;
    }

    const initTags = this.serverInitializeEvent?.tags;
    const supportsEphemeralFromInit =
      Array.isArray(initTags) &&
      hasSingleTag(
        initTags as string[][],
        NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
      );

    return supportsEphemeralFromInit
      ? EPHEMERAL_GIFT_WRAP_KIND
      : GIFT_WRAP_KIND;
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

      // Learn server transport capabilities from any inbound server envelope tags.
      // This enables ephemeral gift wrap discovery even when clients operate in stateless
      // mode (no real initialize handshake observed).
      if (
        !this.serverSupportsEphemeralGiftWraps &&
        Array.isArray(nostrEvent.tags) &&
        hasSingleTag(
          nostrEvent.tags as string[][],
          NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
        )
      ) {
        this.serverSupportsEphemeralGiftWraps = true;
      }

      const eTag = getNostrEventTag(nostrEvent.tags, 'e');

      if (!this.serverInitializeEvent && hasKnownDiscoveryTag(nostrEvent)) {
        this.serverInitializeEvent = nostrEvent;
        this.logger.info('Learned server discovery tags from direct response', {
          eventId: nostrEvent.id,
        });
      }

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

  /**
   * Gets the parsed initialize result from the server's initialize event content.
   * @returns The parsed initialize result or undefined when unavailable or invalid
   */
  public getServerInitializeResult(): InitializeResult | undefined {
    if (!this.serverInitializeEvent) {
      return undefined;
    }

    try {
      const content = JSON.parse(this.serverInitializeEvent.content) as {
        result?: unknown;
      };
      const parse = InitializeResultSchema.safeParse(content.result);
      return parse.success ? parse.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Returns whether the server initialize event advertises encrypted transport support.
   * @returns True when the initialize event contains the support_encryption tag
   */
  public serverSupportsEncryption(): boolean {
    return hasEventTag(
      this.serverInitializeEvent,
      NOSTR_TAGS.SUPPORT_ENCRYPTION,
    );
  }

  /**
   * Returns whether the server initialize event advertises ephemeral gift wrap support.
   * @returns True when the initialize event contains the support_encryption_ephemeral tag
   */
  public serverSupportsEphemeralEncryption(): boolean {
    return hasEventTag(
      this.serverInitializeEvent,
      NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
    );
  }

  /**
   * Gets the server name tag from the initialize event.
   * @returns The name tag value or undefined
   */
  public getServerInitializeName(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.NAME,
    );
  }

  /**
   * Gets the server about tag from the initialize event.
   * @returns The about tag value or undefined
   */
  public getServerInitializeAbout(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.ABOUT,
    );
  }

  /**
   * Gets the server website tag from the initialize event.
   * @returns The website tag value or undefined
   */
  public getServerInitializeWebsite(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.WEBSITE,
    );
  }

  /**
   * Gets the server picture tag from the initialize event.
   * @returns The picture tag value or undefined
   */
  public getServerInitializePicture(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.PICTURE,
    );
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

  private async resolveOperationalRelayHandler(): Promise<void> {
    const configuredRelayUrls = this.relayHandler.getRelayUrls?.() ?? [];

    if (configuredRelayUrls.length > 0) {
      return;
    }

    if (this.hintedRelayUrls.length > 0) {
      this.logger.info('Using relay hints from server identity', {
        relayCount: this.hintedRelayUrls.length,
      });
      this.setRelayHandler([...this.hintedRelayUrls]);
      return;
    }

    if (this.discoveryRelayUrls.length === 0) {
      if (this.fallbackOperationalRelayUrls.length > 0) {
        this.logger.info('Using configured fallback operational relays', {
          relayCount: this.fallbackOperationalRelayUrls.length,
        });
        this.setRelayHandler([...this.fallbackOperationalRelayUrls]);
      }
      return;
    }

    const discoveryPromise = fetchServerRelayList({
      serverPubkey: this.serverPubkey,
      relayUrls: [...this.discoveryRelayUrls],
    }).then((relayListEntries) => ({
      source: 'discovery' as const,
      relayUrls: selectOperationalRelayUrls(relayListEntries),
    }));

    const fallbackPromise = this.resolveFallbackOperationalRelayUrls();

    const firstResult = await Promise.race([discoveryPromise, fallbackPromise]);

    if (firstResult.relayUrls.length > 0) {
      this.logger.info('Resolved operational relays', {
        relayCount: firstResult.relayUrls.length,
        source: firstResult.source,
      });
      this.setRelayHandler(firstResult.relayUrls);
      return;
    }

    const [discoveryResult, fallbackResult] = await Promise.all([
      discoveryPromise,
      fallbackPromise,
    ]);

    if (discoveryResult.relayUrls.length > 0) {
      this.logger.info('Resolved operational relays from server relay list', {
        relayCount: discoveryResult.relayUrls.length,
      });
      this.setRelayHandler(discoveryResult.relayUrls);
      return;
    }

    if (fallbackResult.relayUrls.length > 0) {
      this.logger.info('Using configured fallback operational relays', {
        relayCount: fallbackResult.relayUrls.length,
      });
      this.setRelayHandler(fallbackResult.relayUrls);
      return;
    }

    this.logger.warn(
      'No operational relays discovered from kind 10002; falling back to discovery relays',
      {
        relayCount: this.discoveryRelayUrls.length,
      },
    );
    this.setRelayHandler([...this.discoveryRelayUrls]);
  }

  private async resolveFallbackOperationalRelayUrls(): Promise<{
    source: 'fallback';
    relayUrls: string[];
  }> {
    if (this.fallbackOperationalRelayUrls.length === 0) {
      return {
        source: 'fallback',
        relayUrls: [],
      };
    }

    const relayPool = new ApplesauceRelayPool([
      ...this.fallbackOperationalRelayUrls,
    ]);

    try {
      await withTimeout(
        relayPool.connect(),
        DEFAULT_TIMEOUT_MS,
        'Fallback operational relay probing timed out',
      );
      return {
        source: 'fallback',
        relayUrls: [...this.fallbackOperationalRelayUrls],
      };
    } catch {
      return {
        source: 'fallback',
        relayUrls: [],
      };
    } finally {
      await relayPool.disconnect().catch(() => undefined);
    }
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
      serverPubkey: this.serverPubkey,
      discoveryRelayUrls: [...this.discoveryRelayUrls],
      fallbackOperationalRelayUrls: [...this.fallbackOperationalRelayUrls],
      relayUrls: this.relayHandler.getRelayUrls?.() ?? [],
      serverInitializeEvent: this.serverInitializeEvent,
      serverToolsListEvent: this.serverToolsListEvent,
      serverResourcesListEvent: this.serverResourcesListEvent,
      serverResourceTemplatesListEvent: this.serverResourceTemplatesListEvent,
      serverPromptsListEvent: this.serverPromptsListEvent,
    };
  }
}
