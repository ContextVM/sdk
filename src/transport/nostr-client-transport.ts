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

import {
  ClientCorrelationStore,
  PendingRequest,
  type OriginalRequestContext,
} from './nostr-client/correlation-store.js';
import { parseServerIdentity } from './nostr-client/server-identity.js';
import { resolveOperationalRelays } from './nostr-client/relay-resolution.js';
import { StatelessModeHandler } from './nostr-client/stateless-mode-handler.js';
import { queryTags } from '../core/utils/utils.js';
import {
  OversizedTransferReceiver,
  type TransferPolicy,
} from './oversized-transfer/index.js';
import {
  OpenStreamSession,
} from './open-stream/index.js';

import {
  parseDiscoveredPeerCapabilities,
  ClientCapabilityNegotiator,
} from './capability-negotiator.js';
import { ClientInboundNotificationDispatcher } from './nostr-client/inbound-notification-dispatcher.js';
import { ClientEventPipeline } from './nostr-client/event-pipeline.js';
import { ClientOpenStreamFactory } from './nostr-client/open-stream-factory.js';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERSIZED_THRESHOLD,
} from './oversized-transfer/constants.js';
import { sendOversizedClientRequest } from './nostr-client/oversized-client-sender.js';
import type { OpenStreamTransportPolicy } from './open-stream-policy.js';

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
  /** Options controlling CEP-22 oversized payload transfer. */
  oversizedTransfer?: {
    /** Whether oversized transfer is enabled. @default true */
    enabled?: boolean;
    /**
     * Byte threshold at which the sender proactively fragments a message.
     * @default DEFAULT_OVERSIZED_THRESHOLD (48 000)
     */
    thresholdBytes?: number;
    /** Per-chunk data size in bytes. @default DEFAULT_CHUNK_SIZE (48 000) */
    chunkSizeBytes?: number;
    /** Timeout while waiting for `accept` when handshake is required. */
    acceptTimeoutMs?: number;
    /** Receiver-side admission policy. */
    policy?: TransferPolicy;
  };
  /** Options controlling CEP-41 open-ended stream transfer. */
  openStream?: {
    /** Whether open stream transfer is enabled. @default false */
    enabled?: boolean;
    /** Receiver/session policy reserved for CEP-41 stream lifecycle limits. */
    policy?: OpenStreamTransportPolicy;
  };
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
  private readonly pendingOutboundOpenStreamResolvers: Array<{
    resolve: (value: {
      progressToken: string;
      stream: OpenStreamSession;
    }) => void;
    reject: (error: Error) => void;
  }> = [];

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

  /** Whether the server has advertised CEP-22 oversized transfer support. */
  private serverSupportsOversizedTransfer: boolean = false;

  /** Whether the server has advertised CEP-41 open stream support. */
  private serverSupportsOpenStream: boolean = false;

  private readonly capabilityNegotiator: ClientCapabilityNegotiator;
  private readonly inboundNotificationDispatcher: ClientInboundNotificationDispatcher;
  private readonly eventPipeline: ClientEventPipeline;

  // Oversized-transfer sender settings
  private readonly oversizedEnabled: boolean;
  private readonly oversizedThreshold: number;
  private readonly oversizedChunkSize: number;
  private readonly oversizedAcceptTimeoutMs: number;
  private readonly openStreamEnabled: boolean;

  private readonly openStreamFactory: ClientOpenStreamFactory;

  /** Receives inbound oversized-transfer frames from the server (server→client responses). */
  private readonly oversizedReceiver: OversizedTransferReceiver;

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

    const ot = options.oversizedTransfer;
    this.oversizedEnabled = ot?.enabled ?? true;
    this.oversizedThreshold = ot?.thresholdBytes ?? DEFAULT_OVERSIZED_THRESHOLD;
    this.oversizedChunkSize = ot?.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE;
    this.oversizedAcceptTimeoutMs = ot?.acceptTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.oversizedReceiver = new OversizedTransferReceiver(
      ot?.policy ?? {},
      this.logger,
    );
    this.openStreamEnabled = options.openStream?.enabled ?? false;
    this.openStreamFactory = new ClientOpenStreamFactory({
      openStreamEnabled: this.openStreamEnabled,
      policy: options.openStream?.policy,
      send: this.send.bind(this),
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });

    this.capabilityNegotiator = new ClientCapabilityNegotiator({
      encryptionMode: this.encryptionMode,
      giftWrapMode: this.giftWrapMode,
      oversizedEnabled: this.oversizedEnabled,
      openStreamEnabled: this.openStreamEnabled,
      composeOutboundTags: this.composeOutboundTags.bind(this),
    });

    this.inboundNotificationDispatcher = new ClientInboundNotificationDispatcher({
      openStreamReceiver: this.openStreamFactory.getReceiver(),
      oversizedReceiver: this.oversizedReceiver,
      handleResponse: this.handleResponse.bind(this),
      handleNotification: this.handleNotification.bind(this),
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });

    this.eventPipeline = new ClientEventPipeline({
      signer: this.signer,
      seenEventIds: this.seenEventIds,
      serverPubkey: this.serverPubkey,
      giftWrapMode: this.giftWrapMode,
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });
  }

  /**
   * Sets the client PMI preference list used for CEP-8 discovery/negotiation.
   *
   * Intended to be called by payments wrappers (e.g. `withClientPayments()`).
   */
  public setClientPmis(pmis: readonly string[]): void {
    this.capabilityNegotiator.setClientPmis(pmis);
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
      const pendingOpenStreamError = new Error(
        'Transport closed before outbound open-stream session was created',
      );
      for (const pending of this.pendingOutboundOpenStreamResolvers.splice(0)) {
        pending.reject(pendingOpenStreamError);
      }
      this.correlationStore.clear();
      this.seenEventIds.clear();
      this.oversizedReceiver.clear();
      this.openStreamFactory.getReceiver().clear();
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

    // --- CEP-22 Oversized Transfer (proactive path) ---
    if (this.oversizedEnabled && isRequest) {
      const progressToken = message.params?._meta?.progressToken;
      if (progressToken !== undefined) {
        const serialized = JSON.stringify(message);
        const byteLength = new TextEncoder().encode(serialized).byteLength;
        if (byteLength > this.oversizedThreshold) {
          await this.sendOversizedRequest(
            message,
            serialized,
            String(progressToken),
          );
          return 'oversized-transfer';
        }
      }
    }

    const tags = this.capabilityNegotiator.buildOutboundTags({
      baseTags: this.createRecipientTags(this.serverPubkey),
      includeDiscovery: isRequest,
    });

    const giftWrapKind = this.capabilityNegotiator.chooseOutboundGiftWrapKind();

    const eventId = await this.sendMcpMessage(
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

        if (
          isRequest &&
          message.method === 'tools/call' &&
          progressToken !== undefined
        ) {
          const pending = this.pendingOutboundOpenStreamResolvers.shift();
          if (pending) {
            const normalizedProgressToken = String(progressToken);
            pending.resolve({
              progressToken: normalizedProgressToken,
              stream: this.createOutboundOpenStreamSession(
                normalizedProgressToken,
              ),
            });
          }
        }
      },
      giftWrapKind,
    );

    if (isRequest) {
      this.capabilityNegotiator.markDiscoveryTagsSent();
    }

    return eventId;
  }

  //Splits an oversized request into CEP-22 transfer frames and sends them sequentially. Waits for an `accept` frame from the server when the server's support is not yet known.

  private async sendOversizedRequest(
    originalMessage: Extract<
      JSONRPCMessage,
      { id: string | number; method: string }
    >,
    serialized: string,
    progressToken: string,
  ): Promise<void> {
    const frameRecipientTags = this.createRecipientTags(this.serverPubkey);
    const startFrameTags = this.capabilityNegotiator.buildOutboundTags({
      baseTags: frameRecipientTags,
      includeDiscovery: true,
    });
    const endFrameEventId = await sendOversizedClientRequest(
      serialized,
      progressToken,
      {
        chunkSizeBytes: this.oversizedChunkSize,
        acceptTimeoutMs: this.oversizedAcceptTimeoutMs,
        serverPubkey: this.serverPubkey,
        serverSupportsOversizedTransfer: this.serverSupportsOversizedTransfer,
        giftWrapKind: this.capabilityNegotiator.chooseOutboundGiftWrapKind(),
        startFrameTags,
        continuationFrameTags: frameRecipientTags,
      },
      {
        sendMcpMessage: this.sendMcpMessage.bind(this),
        waitForAccept: this.oversizedReceiver.waitForAccept.bind(
          this.oversizedReceiver,
        ),
        logger: this.logger,
      },
    );

    // Register the original request for correlating the final response.
    if (endFrameEventId) {
      this.correlationStore.registerRequest(endFrameEventId, {
        originalRequestId: originalMessage.id,
        isInitialize: originalMessage.method === INITIALIZE_METHOD,
        progressToken,
        originalRequestContext: this.getOriginalRequestContext(originalMessage),
      });
    }

    this.capabilityNegotiator.markDiscoveryTagsSent();
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
   * Returns the CEP-41 stream session for a progress token, creating it lazily if needed.
   */
  public getOrCreateOpenStreamSession(
    progressToken: string,
  ): OpenStreamSession {
    return this.openStreamFactory.getOrCreateSession(progressToken);
  }

  /**
   * Returns an outbound CEP-41 session whose local abort publishes an abort
   * notification to the server.
   */
  public createOutboundOpenStreamSession(
    progressToken: string,
  ): OpenStreamSession {
    return this.openStreamFactory.createOutboundSession(progressToken);
  }

  /**
   * Resolves the next outbound CEP-41 session created from an SDK-generated progress token.
   */
  public prepareOutboundOpenStreamSession(): Promise<{
    progressToken: string;
    stream: OpenStreamSession;
  }> {
    return new Promise((resolve, reject) => {
      this.pendingOutboundOpenStreamResolvers.push({ resolve, reject });
    });
  }

  /**
   * Returns the CEP-41 stream session for a progress token when it already exists.
   */
  public getOpenStreamSession(
    progressToken: string,
  ): OpenStreamSession | undefined {
    return this.openStreamFactory.getSession(progressToken);
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
      const unwrapped = await this.eventPipeline.unwrap(event);
      if (!unwrapped) {
        return;
      }
      const nostrEvent = unwrapped.event;

      this.learnServerDiscovery(nostrEvent);

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
    return queryTags(this.serverInitializeEvent, NOSTR_TAGS.SUPPORT_ENCRYPTION)
      .isFlag;
  }

  /**
   * Returns whether the server initialize event advertises ephemeral gift wrap support.
   * @returns True when the initialize event contains the support_encryption_ephemeral tag
   */
  public serverSupportsEphemeralEncryption(): boolean {
    return queryTags(
      this.serverInitializeEvent,
      NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
    ).isFlag;
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

  private learnServerDiscovery(event: NostrEvent): void {
    if (!Array.isArray(event.tags)) {
      return;
    }

    const discovered = parseDiscoveredPeerCapabilities(event.tags);
    if (discovered.discoveryTags.length === 0) {
      return;
    }

    this.capabilityNegotiator.learnServerCapabilities(discovered);
    this.serverSupportsOversizedTransfer ||=
      discovered.supportsOversizedTransfer;
    this.serverSupportsOpenStream ||= discovered.supportsOpenStream;

    if (!this.serverInitializeEvent) {
      this.serverInitializeEvent = event;
      this.capabilityNegotiator.setServerInitializeEvent(event);
      this.logger.info('Learned server discovery tags from inbound event', {
        eventId: event.id,
      });
      return;
    }

    const currentHasInitializeResult = InitializeResultSchema.safeParse(
      this.getInitializeResultCandidate(event),
    ).success;
    const existingHasInitializeResult = InitializeResultSchema.safeParse(
      this.getInitializeResultCandidate(this.serverInitializeEvent),
    ).success;

    if (!existingHasInitializeResult && currentHasInitializeResult) {
      this.serverInitializeEvent = event;
      this.capabilityNegotiator.setServerInitializeEvent(event);
      this.logger.info(
        'Upgraded learned server discovery event to initialize response',
        {
          eventId: event.id,
        },
      );
    }
  }

  private getInitializeResultCandidate(event: NostrEvent): unknown {
    try {
      const content = JSON.parse(event.content) as { result?: unknown };
      return content.result;
    } catch {
      return undefined;
    }
  }

  private async resolveOperationalRelayHandler(): Promise<void> {
    await resolveOperationalRelays(
      {
        configuredRelayUrls: this.relayHandler.getRelayUrls?.() ?? [],
        hintedRelayUrls: this.hintedRelayUrls,
        discoveryRelayUrls: this.discoveryRelayUrls,
        fallbackOperationalRelayUrls: this.fallbackOperationalRelayUrls,
        serverPubkey: this.serverPubkey,
      },
      {
        setRelayHandler: this.setRelayHandler.bind(this),
        logger: this.logger,
      },
    );
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

      if (
        correlatedEventId &&
        !this.correlationStore.hasPendingRequest(correlatedEventId)
      ) {
        this.logger.warn('Received notification for unknown/expired request', {
          eventId,
          correlatedEventId,
          reason:
            'Notification carried correlation `e` tag that does not map to a pending request',
        });
        return;
      }

      if (this.inboundNotificationDispatcher.tryIntercept(mcpMessage, eventId, correlatedEventId)) {
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
      oversizedReceiver: this.oversizedReceiver,
      openStreamReceiver: this.openStreamFactory.getReceiver(),
    };
  }
}
