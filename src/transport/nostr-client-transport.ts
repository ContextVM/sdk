import {
  type InitializeResult,
  NotificationSchema,
  type JSONRPCMessage,
  isJSONRPCRequest,
  isJSONRPCNotification,
  type JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  DEFAULT_BOOTSTRAP_RELAY_URLS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LRU_SIZE,
  INITIALIZE_METHOD,
} from '../core/index.js';
import { LruCache } from '../core/utils/lru-cache.js';
import {
  BaseNostrTransport,
  BaseNostrTransportOptions,
} from './base-nostr-transport.js';
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
import {
  OversizedTransferReceiver,
  type TransferPolicy,
} from './oversized-transfer/index.js';
import {
  OpenStreamSession,
} from './open-stream/index.js';

import { ClientCapabilityNegotiator } from './capability-negotiator.js';
import { ClientInboundCoordinator } from './nostr-client/inbound-coordinator.js';
import { ServerMetadataStore } from './nostr-client/server-metadata-store.js';
import { ClientOutboundSender } from './nostr-client/outbound-sender.js';
import { ClientInboundNotificationDispatcher } from './nostr-client/inbound-notification-dispatcher.js';
import { ClientEventPipeline } from './nostr-client/event-pipeline.js';
import { ClientOpenStreamFactory } from './nostr-client/open-stream-factory.js';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERSIZED_THRESHOLD,
} from './oversized-transfer/constants.js';
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
  /** Stores server discovery metadata learned from inbound events. */
  private readonly metadataStore: ServerMetadataStore;

  private readonly capabilityNegotiator: ClientCapabilityNegotiator;
  private readonly inboundNotificationDispatcher: ClientInboundNotificationDispatcher;
  private readonly eventPipeline: ClientEventPipeline;
  private readonly inboundCoordinator: ClientInboundCoordinator;
  private readonly outboundSender: ClientOutboundSender;

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
    this.metadataStore = new ServerMetadataStore();

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

    this.inboundCoordinator = new ClientInboundCoordinator({
      capabilityNegotiator: this.capabilityNegotiator,
      correlationStore: this.correlationStore,
      notificationDispatcher: this.inboundNotificationDispatcher,
      metadataStore: this.metadataStore,
      unwrapEvent: this.eventPipeline.unwrap.bind(this.eventPipeline),
      convertNostrEventToMcpMessage:
        this.convertNostrEventToMcpMessage.bind(this),
      handleResponse: this.handleResponse.bind(this),
      handleNotification: this.handleNotification.bind(this),
      logger: this.logger,
      onerror: (error: Error) => this.onerror?.(error),
    });

    this.outboundSender = new ClientOutboundSender({
      serverPubkey: this.serverPubkey,
      correlationStore: this.correlationStore,
      capabilityNegotiator: this.capabilityNegotiator,
      oversizedEnabled: this.oversizedEnabled,
      oversizedThreshold: this.oversizedThreshold,
      oversizedChunkSize: this.oversizedChunkSize,
      oversizedAcceptTimeoutMs: this.oversizedAcceptTimeoutMs,
      serverSupportsOversizedTransfer: () =>
        this.metadataStore.getServerSupportsOversizedTransfer(),
      createRecipientTags: this.createRecipientTags.bind(this),
      sendMcpMessage: this.sendMcpMessage.bind(this),
      waitForAccept: this.oversizedReceiver.waitForAccept.bind(
        this.oversizedReceiver,
      ),
      getOriginalRequestContext: this.getOriginalRequestContext.bind(this),
      resolvePendingOpenStream: this.resolvePendingOutboundOpenStream.bind(this),
      measurePublishedMcpMessageSize: this.measurePublishedMcpMessageSize.bind(this),
      resolveSafeOversizedChunkSize: this.resolveSafeOversizedChunkSize.bind(this),
      logger: this.logger,
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
      this.metadataStore.clear();
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

      await this.outboundSender.sendRequest(message);
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

  /** Resolves the next outbound open-stream placeholder with an active session. */
  private resolvePendingOutboundOpenStream(progressToken: string): void {
    const pending = this.pendingOutboundOpenStreamResolvers.shift();
    if (!pending) {
      return;
    }
    pending.resolve({
      progressToken,
      stream: this.createOutboundOpenStreamSession(progressToken),
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
    await this.inboundCoordinator.processIncomingEvent(event);
  }

  /**
   * Gets the server's initialize event if received.
   * @returns The server initialize event or undefined
   */
  public getServerInitializeEvent(): NostrEvent | undefined {
    return this.metadataStore.getServerInitializeEvent();
  }

  /**
   * Gets the parsed initialize result from the server's initialize event content.
   * @returns The parsed initialize result or undefined when unavailable or invalid
   */
  public getServerInitializeResult(): InitializeResult | undefined {
    return this.metadataStore.getServerInitializeResult();
  }

  /**
   * Returns whether the server initialize event advertises encrypted transport support.
   * @returns True when the initialize event contains the support_encryption tag
   */
  public serverSupportsEncryption(): boolean {
    return this.metadataStore.serverSupportsEncryption();
  }

  /**
   * Returns whether the server initialize event advertises ephemeral gift wrap support.
   * @returns True when the initialize event contains the support_encryption_ephemeral tag
   */
  public serverSupportsEphemeralEncryption(): boolean {
    return this.metadataStore.serverSupportsEphemeralEncryption();
  }

  /**
   * Gets the server name tag from the initialize event.
   * @returns The name tag value or undefined
   */
  public getServerInitializeName(): string | undefined {
    return this.metadataStore.getServerInitializeName();
  }

  /**
   * Gets the server about tag from the initialize event.
   * @returns The about tag value or undefined
   */
  public getServerInitializeAbout(): string | undefined {
    return this.metadataStore.getServerInitializeAbout();
  }

  /**
   * Gets the server website tag from the initialize event.
   * @returns The website tag value or undefined
   */
  public getServerInitializeWebsite(): string | undefined {
    return this.metadataStore.getServerInitializeWebsite();
  }

  /**
   * Gets the server picture tag from the initialize event.
   * @returns The picture tag value or undefined
   */
  public getServerInitializePicture(): string | undefined {
    return this.metadataStore.getServerInitializePicture();
  }

  /** Gets the server's most recently observed tools/list event envelope, if any. */
  public getServerToolsListEvent(): NostrEvent | undefined {
    return this.metadataStore.getServerToolsListEvent();
  }

  /** Gets the server's most recently observed resources/list event envelope, if any. */
  public getServerResourcesListEvent(): NostrEvent | undefined {
    return this.metadataStore.getServerResourcesListEvent();
  }

  /** Gets the server's most recently observed resources/templates/list event envelope, if any. */
  public getServerResourceTemplatesListEvent(): NostrEvent | undefined {
    return this.metadataStore.getServerResourceTemplatesListEvent();
  }

  /** Gets the server's most recently observed prompts/list event envelope, if any. */
  public getServerPromptsListEvent(): NostrEvent | undefined {
    return this.metadataStore.getServerPromptsListEvent();
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

  protected buildOutboundClientTags(params: {
    baseTags: readonly string[][];
    includeDiscovery: boolean;
  }): string[][] {
    return this.capabilityNegotiator.buildOutboundTags(params);
  }

  protected chooseOutboundGiftWrapKind(): number {
    return this.capabilityNegotiator.chooseOutboundGiftWrapKind();
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
      serverInitializeEvent: this.metadataStore.getServerInitializeEvent(),
      serverToolsListEvent: this.metadataStore.getServerToolsListEvent(),
      serverResourcesListEvent: this.metadataStore.getServerResourcesListEvent(),
      serverResourceTemplatesListEvent:
        this.metadataStore.getServerResourceTemplatesListEvent(),
      serverPromptsListEvent: this.metadataStore.getServerPromptsListEvent(),
      oversizedReceiver: this.oversizedReceiver,
      openStreamReceiver: this.openStreamFactory.getReceiver(),
    };
  }
}
