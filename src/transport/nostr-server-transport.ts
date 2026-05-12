import {
  type ListToolsResult,
  isJSONRPCNotification,
  type JSONRPCMessage,
  type JSONRPCResponse,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  JSONRPCErrorResponse,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  BaseNostrTransport,
  BaseNostrTransportOptions,
} from './base-nostr-transport.js';
import {
  CTXVM_MESSAGES_KIND,
  DEFAULT_TIMEOUT_MS,
  NOSTR_TAGS,
  DEFAULT_LRU_SIZE,
} from '../core/index.js';
import { NostrEvent } from 'nostr-tools';
import { LogLevel } from '../core/utils/logger.js';
import { withTimeout } from '../core/utils/utils.js';
import { CorrelationStore } from './nostr-server/correlation-store.js';
import { ClientSession, SessionStore } from './nostr-server/session-store.js';
import { LruCache } from '../core/utils/lru-cache.js';
import { ApplesauceRelayPool } from '../relay/applesauce-relay-pool.js';
import {
  AuthorizationPolicy,
  CapabilityExclusion,
} from './nostr-server/authorization-policy.js';
import {
  AnnouncementManager,
  type ProfileMetadata,
  type ServerInfo,
} from './nostr-server/announcement-manager.js';
import type { RelayHandler } from '../core/interfaces.js';
import {
  OversizedTransferReceiver,
  type TransferPolicy,
} from './oversized-transfer/index.js';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_OVERSIZED_THRESHOLD,
} from './oversized-transfer/constants.js';
import { ServerCapabilityNegotiator } from './capability-negotiator.js';
import type { OpenStreamTransportPolicy } from './open-stream-policy.js';
import { InboundNotificationDispatcher } from './nostr-server/inbound-notification-dispatcher.js';
import { OutboundResponseRouter } from './nostr-server/outbound-response-router.js';
import { OutboundNotificationBroadcaster } from './nostr-server/outbound-notification-broadcaster.js';
import { ServerOpenStreamFactory } from './nostr-server/open-stream-factory.js';
import { ServerEventPipeline } from './nostr-server/event-pipeline.js';
import { ServerInboundCoordinator } from './nostr-server/inbound-coordinator.js';
import type { InboundMiddlewareFn } from './middleware.js';

export type { InboundMiddlewareFn } from './middleware.js';
/**
 * Options for configuring the NostrServerTransport.
 */
export interface NostrServerTransportOptions extends BaseNostrTransportOptions {
  serverInfo?: ServerInfo;
  /** Optional NIP-01 kind:0 profile metadata for server identity (CEP-23). Opt-in. */
  profileMetadata?: ProfileMetadata;
  /**
   * @deprecated Use `isAnnouncedServer` instead. `isPublicServer` will be removed in a future version.
   */
  isPublicServer?: boolean;
  /**
   * Whether this server publishes public announcement events on Nostr for relay-based discovery.
   * When true, the server publishes kinds 11316-11320 events describing its capabilities.
   * Does not by itself determine access control — use `allowedPublicKeys` for that.
   * @default false
   */
  isAnnouncedServer?: boolean;
  /** Whether to publish kind 10002 relay list metadata. @default true */
  publishRelayList?: boolean;
  /** Explicit relay URLs to advertise in kind 10002. Falls back to relayHandler.getRelayUrls() when omitted. */
  relayListUrls?: string[];
  /** Additional relays used only as discoverability publication targets. */
  bootstrapRelayUrls?: readonly string[];
  allowedPublicKeys?: string[];
  /** Optional callback for dynamic public key authorization. Returns true to allow the pubkey. */
  isPubkeyAllowed?: (clientPubkey: string) => boolean | Promise<boolean>;
  /** List of capabilities that are excluded from public key whitelisting requirements */
  excludedCapabilities?: CapabilityExclusion[];
  /** Optional callback for dynamic capability exclusions. Returns true to bypass pubkey authorization. */
  isCapabilityExcluded?: (
    exclusion: CapabilityExclusion,
  ) => boolean | Promise<boolean>;
  /** Log level for the NostrServerTransport: 'debug' | 'info' | 'warn' | 'error' | 'silent' */
  logLevel?: LogLevel;
  /** Maximum number of client sessions to keep in memory. @default 1000 */
  maxSessions?: number;
  /**
   * Whether to inject the client's public key into the _meta field of incoming messages.
   * @default false
   */
  injectClientPubkey?: boolean;

  /**
   * Whether to inject the inbound request event ID into the `_meta` field of
   * incoming request messages.
   * @default false
   */
  injectRequestEventId?: boolean;

  /**
   * Optional callback invoked when a client session is evicted.
   * Useful for external resource cleanup (e.g., per-client MCP transport sessions).
   */
  onClientSessionEvicted?: (ctx: {
    clientPubkey: string;
    session: ClientSession;
  }) => void | Promise<void>;

  /**
   * Optional inbound middleware hook to gate or transform messages before they are
   * forwarded to MCP server code via `onmessage` / `onmessageWithContext`.
   */
  inboundMiddleware?: (
    message: JSONRPCMessage,
    ctx: { clientPubkey: string },
    forward: (message: JSONRPCMessage) => Promise<void>,
  ) => Promise<void>;
  /** Options controlling CEP-22 oversized payload transfer. */
  oversizedTransfer?: {
    /** Whether oversized transfer is enabled. @default true */
    enabled?: boolean;
    /**
     * Byte threshold at which the server proactively fragments a response.
     * @default DEFAULT_OVERSIZED_THRESHOLD (48 000)
     */
    thresholdBytes?: number;
    /** Per-chunk data size in bytes. @default DEFAULT_CHUNK_SIZE (48 000) */
    chunkSizeBytes?: number;
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

export type ListToolsResultTransformer = (
  result: ListToolsResult,
) => ListToolsResult;

export type ListToolsAnnouncementTagsProducer = (
  result: ListToolsResult,
) => string[][];


/**
 * A server-side transport layer for CTXVM that uses Nostr events for communication.
 * This transport listens for incoming MCP requests via Nostr events and can send
 * responses back to the originating clients. It handles all request/response correlation
 * internally, making it a standalone MCP transport that works over Nostr.
 */
export class NostrServerTransport
  extends BaseNostrTransport
  implements Transport
{
  public onmessage?: (message: JSONRPCMessage) => void;
  public onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { clientPubkey: string },
  ) => void;
  public onclose?: () => void;
  public onerror?: (error: Error) => void;

  private readonly sessionStore: SessionStore;
  private readonly correlationStore: CorrelationStore;
  private readonly authorizationPolicy: AuthorizationPolicy;
  private readonly announcementManager: AnnouncementManager;
  private readonly injectClientPubkey: boolean;
  private readonly shouldInjectRequestEventId: boolean;
  private readonly onClientSessionEvicted:
    | ((ctx: {
        clientPubkey: string;
        session: ClientSession;
      }) => void | Promise<void>)
    | undefined;
  private readonly inboundMiddlewares: InboundMiddlewareFn[] = [];
  private readonly listToolsResultTransformers: ListToolsResultTransformer[] =
    [];
  private readonly listToolsAnnouncementTagsProducers: ListToolsAnnouncementTagsProducer[] =
    [];

  /**
   * Deduplicate inbound events to avoid redundant work.
   *
   * Used for gift-wrap envelopes (outer event ids) and decrypted inner events.
   */
  private readonly seenEventIds = new LruCache<true>(DEFAULT_LRU_SIZE);

  /** Receives inbound oversized-transfer frames from clients (client→server requests). */
  private readonly oversizedReceiver: OversizedTransferReceiver;

  // Oversized-transfer sender settings (for server→client responses)
  private readonly oversizedEnabled: boolean;
  private readonly oversizedThreshold: number;
  private readonly oversizedChunkSize: number;
  private readonly openStreamEnabled: boolean;
  private readonly capabilityNegotiator: ServerCapabilityNegotiator;
  private readonly openStreamFactory: ServerOpenStreamFactory;
  private readonly eventPipeline: ServerEventPipeline;
  private readonly inboundCoordinator: ServerInboundCoordinator;
  private readonly inboundNotificationDispatcher: InboundNotificationDispatcher;
  private readonly outboundResponseRouter: OutboundResponseRouter;
  private readonly outboundNotificationBroadcaster: OutboundNotificationBroadcaster;

  constructor(options: NostrServerTransportOptions) {
    super('nostr-server-transport', options);
    this.injectClientPubkey = options.injectClientPubkey ?? false;
    this.shouldInjectRequestEventId = options.injectRequestEventId ?? false;
    this.onClientSessionEvicted = options.onClientSessionEvicted;
    if (options.inboundMiddleware) {
      this.inboundMiddlewares.push(options.inboundMiddleware);
    }

    // Initialize authorization policy
    this.authorizationPolicy = new AuthorizationPolicy({
      allowedPublicKeys: options.allowedPublicKeys
        ? new Set(options.allowedPublicKeys)
        : undefined,
      isPubkeyAllowed: options.isPubkeyAllowed,
      excludedCapabilities: options.excludedCapabilities,
      isCapabilityExcluded: options.isCapabilityExcluded,
      isAnnouncedServer: options.isAnnouncedServer ?? options.isPublicServer,
    });

    // Initialize session store with eviction callback for correlation cleanup
    this.sessionStore = new SessionStore({
      maxSessions: options.maxSessions ?? 1000,
      onSessionEvicted: (clientPubkey, session) => {
        // Clean up all correlation data for evicted session
        const removedCount =
          this.correlationStore.removeRoutesForClient(clientPubkey);
        this.logger.info(
          `Evicted session for ${clientPubkey} (removed ${removedCount} routes)`,
        );

        // If there are still active routes (evicted early), recreate the session
        // to prevent losing track of in-flight requests
        if (this.correlationStore.hasActiveRoutesForClient(clientPubkey)) {
          this.logger.debug(
            `Recreating session ${clientPubkey} due to active routes`,
          );
          this.sessionStore.getOrCreateSession(
            clientPubkey,
            session.isEncrypted,
          );
          return; // Don't call onClientSessionEvicted for vetoed eviction
        }

        if (this.onClientSessionEvicted) {
          Promise.resolve(
            this.onClientSessionEvicted({ clientPubkey, session }),
          ).catch((error) => {
            this.logger.error('Error in onClientSessionEvicted callback', {
              error: error instanceof Error ? error.message : String(error),
              clientPubkey,
            });
          });
        }
      },
    });

    // Initialize correlation store with bounded event routes
    // Progress tokens use a Map (lifecycle-coupled to routes, no separate bound needed)
    this.correlationStore = new CorrelationStore({
      maxEventRoutes: 10000,
      onEventRouteEvicted: (eventId, route) => {
        this.logger.debug(`Evicted event route for ${eventId}`, {
          clientPubkey: route.clientPubkey,
        });
      },
    });

    // Initialize announcement manager
    this.announcementManager = new AnnouncementManager({
      serverInfo: options.serverInfo,
      profileMetadata: options.profileMetadata,
      encryptionMode: this.encryptionMode,
      giftWrapMode: this.giftWrapMode,
      extraCommonTags: [],
      pricingTags: [],
      publishRelayList: options.publishRelayList,
      relayListUrls: options.relayListUrls,
      bootstrapRelayUrls: options.bootstrapRelayUrls,
      transformListToolsResult: (result) =>
        this.applyListToolsResultTransformers(result),
      getListToolsAnnouncementTags: (result) =>
        this.buildListToolsAnnouncementTags(result),
      onDispatchMessage: (message) => this.onmessage?.(message),
      onPublishEvent: (event) => this.publishEvent(event),
      onPublishEventToRelays: (event, relayUrls) =>
        this.publishEventToRelayUrls(event, relayUrls),
      onSignEvent: (eventTemplate) => this.signer.signEvent(eventTemplate),
      onGetPublicKey: () => this.getPublicKey(),
      onGetRelayUrls: () => this.getRelayUrls(this.relayHandler),
      onSubscribe: (filters, onEvent) =>
        this.relayHandler.subscribe(filters, onEvent).then(() => undefined),
      logger: this.logger,
    });

    const ot = options.oversizedTransfer;
    this.oversizedEnabled = ot?.enabled ?? true;
    this.oversizedThreshold = ot?.thresholdBytes ?? DEFAULT_OVERSIZED_THRESHOLD;
    this.oversizedChunkSize = ot?.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE;
    this.oversizedReceiver = new OversizedTransferReceiver(
      ot?.policy ?? {},
      this.logger,
    );
    this.openStreamEnabled = options.openStream?.enabled ?? false;

    // Advertise CEP-22 support so clients can skip the accept handshake.
    const internalCommonTags: string[][] = [];

    if (this.oversizedEnabled) {
      internalCommonTags.push([NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER]);
    }

    if (this.openStreamEnabled) {
      internalCommonTags.push([NOSTR_TAGS.SUPPORT_OPEN_STREAM]);
    }

    this.announcementManager.setInternalCommonTags(internalCommonTags);

    this.capabilityNegotiator = new ServerCapabilityNegotiator({
      getCommonTags: this.announcementManager.getCommonTags.bind(this.announcementManager),
      composeOutboundTags: this.composeOutboundTags.bind(this),
      giftWrapMode: this.giftWrapMode,
    });

    this.openStreamFactory = new ServerOpenStreamFactory({
      openStreamEnabled: this.openStreamEnabled,
      sendNotification: this.sendNotification.bind(this),
      handleResponse: async (response) => {
        await this.outboundResponseRouter.route(response);
      },
      sessionStore: this.sessionStore,
      onClientSessionEvicted: this.onClientSessionEvicted,
      correlationStore: this.correlationStore,
      policy: options.openStream?.policy,
      logger: this.logger,
    });

    this.inboundCoordinator = new ServerInboundCoordinator({
      sessionStore: this.sessionStore,
      correlationStore: this.correlationStore,
      authorizationPolicy: this.authorizationPolicy,
      openStreamFactory: this.openStreamFactory,
      inboundMiddlewares: this.inboundMiddlewares,
      injectClientPubkey: this.injectClientPubkey,
      shouldInjectRequestEventId: this.shouldInjectRequestEventId,
      oversizedEnabled: this.oversizedEnabled,
      openStreamEnabled: this.openStreamEnabled,
      giftWrapMode: this.giftWrapMode,
      sendMcpMessage: this.sendMcpMessage.bind(this),
      createResponseTags: (clientPubkey, requestId) =>
        this.createResponseTags(clientPubkey, String(requestId)),
      getOrCreateClientSession: this.getOrCreateClientSession.bind(this),
      forwardMessage: async (msg: JSONRPCMessage, clientPubkey: string) => {
        this.onmessage?.(msg);
        this.onmessageWithContext?.(msg, { clientPubkey });
        return true;
      },
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });

    this.inboundNotificationDispatcher = new InboundNotificationDispatcher({
      openStreamReceiver: this.openStreamFactory.getReceiver(),
      oversizedReceiver: this.oversizedReceiver,
      openStreamFactory: this.openStreamFactory,
      correlationStore: this.correlationStore,
      sendNotification: this.sendNotification.bind(this),
      handleIncomingRequest: this.inboundCoordinator.handleIncomingRequest.bind(
        this.inboundCoordinator,
      ),
      handleIncomingNotification:
        this.inboundCoordinator.handleIncomingNotification.bind(
          this.inboundCoordinator,
        ),
      cleanupDroppedRequest: this.inboundCoordinator.cleanupDroppedRequest.bind(
        this.inboundCoordinator,
      ),
      shouldInjectRequestEventId: this.shouldInjectRequestEventId,
      injectClientPubkey: this.injectClientPubkey,
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });

    this.inboundCoordinator.setNotificationDispatcher(this.inboundNotificationDispatcher);



    this.outboundResponseRouter = new OutboundResponseRouter({
      correlationStore: this.correlationStore,
      sessionStore: this.sessionStore,
      announcementManager: this.announcementManager,
      openStreamFactory: this.openStreamFactory,
      oversizedConfig: {
        enabled: this.oversizedEnabled,
        threshold: this.oversizedThreshold,
        chunkSize: this.oversizedChunkSize,
      },
      applyListToolsResultTransformers: this.applyListToolsResultTransformers.bind(this),
      buildOutboundTags: this.capabilityNegotiator.buildOutboundTags.bind(this.capabilityNegotiator),
      createResponseTags: this.createResponseTags.bind(this),
      chooseGiftWrapKind: this.capabilityNegotiator.chooseOutboundGiftWrapKind.bind(this.capabilityNegotiator),
      sendMcpMessage: this.sendMcpMessage.bind(this),
      measurePublishedMcpMessageSize: this.measurePublishedMcpMessageSize.bind(this),
      resolveSafeOversizedChunkSize: this.resolveSafeOversizedChunkSize.bind(this),
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });

    this.outboundNotificationBroadcaster = new OutboundNotificationBroadcaster({
      correlationStore: this.correlationStore,
      sessionStore: this.sessionStore,
      sendNotification: this.sendNotification.bind(this),
      enqueueTask: this.taskQueue.add.bind(this.taskQueue),
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });

    this.eventPipeline = new ServerEventPipeline({
      signer: this.signer,
      seenEventIds: this.seenEventIds,
      encryptionMode: this.encryptionMode,
      giftWrapMode: this.giftWrapMode,
      logger: this.logger,
      onerror: (error) => this.onerror?.(error),
    });
  }

  /**
   * Sets extra tags to include in server announcement + initialize response events.
   *
   * Intended for optional protocol extensions (e.g. CEP-8 PMI discovery).
   */
  public setAnnouncementExtraTags(tags: string[][]): void {
    this.announcementManager.setExtraCommonTags(tags);
  }

  /**
   * Sets pricing tags to include in server announcement + tools list announcement events.
   *
   * Intended for CEP-8 `cap` tag pricing advertisement.
   */
  public setAnnouncementPricingTags(tags: string[][]): void {
    this.announcementManager.setPricingTags(tags);
  }

  /**
   * Adds an inbound middleware function.
   *
   * Middleware runs in the order it is added.
   */
  public addInboundMiddleware(middleware: InboundMiddlewareFn): void {
    this.inboundMiddlewares.push(middleware);
  }

  /**
   * Adds a transformer for `tools/list` results emitted by the server.
   *
   * Transformers are applied to direct responses and public announcement payloads.
   */
  public addListToolsResultTransformer(
    transformer: ListToolsResultTransformer,
  ): void {
    this.listToolsResultTransformers.push(transformer);
  }

  /**
   * Adds a provider for extra tags on public tools/list announcement events.
   */
  public addListToolsAnnouncementTagsProducer(
    producer: ListToolsAnnouncementTagsProducer,
  ): void {
    this.listToolsAnnouncementTagsProducers.push(producer);
  }

  /**
   * Starts the transport, connecting to the relay and setting up event listeners
   * to receive incoming MCP requests.
   */
  public async start(): Promise<void> {
    try {
      // Execute independent async operations in parallel
      const [_connectionResult, pubkey] = await Promise.all([
        this.connect(),
        this.getPublicKey(),
      ]);
      this.logger.info('Server pubkey:', pubkey);
      // Subscribe to events targeting this server's public key
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

      if (this.authorizationPolicy.isAnnouncedServer) {
        await this.announcementManager.publishPublicAnnouncements();
      }

      await this.announcementManager.publishProfileMetadata();

      await this.announcementManager.publishRelayList();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.logAndRethrowError('Error starting NostrServerTransport', error);
    }
  }

  /**
   * Closes the transport, disconnecting from the relay.
   */
  public async close(): Promise<void> {
    try {
      // Shutdown the task queue to prevent new tasks from being queued
      // and clear pending tasks to avoid operating on stale state
      await this.taskQueue.shutdown();

      this.unsubscribeAll();
      await this.disconnect();
      this.sessionStore.clear();
      this.correlationStore.clear();
      this.seenEventIds.clear();
      this.oversizedReceiver.clear();
      this.openStreamFactory.getReceiver().clear();
      this.openStreamFactory.clear();
      this.onclose?.();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.logAndRethrowError('Error closing NostrServerTransport', error);
    }
  }

  /**
   * Sends JSON-RPC messages over the Nostr transport.
   * @param message The JSON-RPC message to send.
   */
  public async send(message: JSONRPCMessage): Promise<void> {
    // Message type detection and routing
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      await this.handleResponse(
        message as JSONRPCResponse | JSONRPCErrorResponse,
      );
    } else if (isJSONRPCNotification(message)) {
      await this.handleNotification(message);
    } else {
      this.onerror?.(new Error('Unknown message type in send()'));
    }
  }

  /**
   * Deletes server announcements and capability listings by publishing deletion events.
   * This method queries for existing announcement events and publishes deletion events (kind 5)
   * to remove them from the relay network.
   * @param reason Optional reason for deletion (default: 'Service offline').
   * @returns Promise that resolves to an array of deletion events that were published.
   */
  public async deleteAnnouncement(
    reason: string = 'Service offline',
  ): Promise<NostrEvent[]> {
    return await this.announcementManager.deleteAnnouncement(reason);
  }

  /**
   * Gets the inbound Nostr request event for an active request, if available.
   *
   * @param requestEventId The inbound signed Nostr request event ID.
   * @returns The signed Nostr request event or `undefined`.
   */
  public getNostrRequestEvent(requestEventId: string): NostrEvent | undefined {
    return this.correlationStore.getRequestEvent(requestEventId);
  }

  /**
   * Gets or creates a client session with proper initialization.
   * @param clientPubkey The client's public key.
   * @param isEncrypted Whether the session uses encryption.
   * @returns The client session.
   */
  private getOrCreateClientSession(
    clientPubkey: string,
    isEncrypted: boolean,
  ): ClientSession {
    const [session, created] = this.sessionStore.getOrCreateSession(
      clientPubkey,
      isEncrypted,
    );
    if (created) {
      this.logger.info(`Session created for ${clientPubkey}`);
    }
    return session;
  }

  private getRelayUrls(relayHandler: RelayHandler): string[] {
    return relayHandler.getRelayUrls();
  }

  private async publishEventToRelayUrls(
    event: NostrEvent,
    relayUrls: string[],
  ): Promise<void> {
    const relayPool = new ApplesauceRelayPool(relayUrls);
    try {
      await withTimeout(
        relayPool.connect(),
        DEFAULT_TIMEOUT_MS,
        'Connection to discoverability relays timed out',
      );

      const controller = new AbortController();
      try {
        await withTimeout(
          relayPool.publish(event, {
            abortSignal: controller.signal,
          }),
          DEFAULT_TIMEOUT_MS,
          'Publish event to discoverability relays timed out',
        );
      } finally {
        controller.abort();
      }
    } finally {
      await relayPool.disconnect().catch((error) => {
        this.logger.warn('Failed to disconnect discoverability relay pool', {
          error: error instanceof Error ? error.message : String(error),
          relayCount: relayUrls.length,
        });
      });
    }
  }



  /**
   * Handles response messages by finding the original request and routing back to client.
   * @param response The JSON-RPC response or error to send.
   */
  private applyListToolsResultTransformers(
    result: ListToolsResult,
  ): ListToolsResult {
    return this.listToolsResultTransformers.reduce(
      (currentResult, transformer) => transformer(currentResult),
      result,
    );
  }

  private buildListToolsAnnouncementTags(result: ListToolsResult): string[][] {
    return this.listToolsAnnouncementTagsProducers.flatMap((producer) =>
      producer(result),
    );
  }

  private async handleResponse(
    response: JSONRPCResponse | JSONRPCErrorResponse,
  ): Promise<void> {
    await this.outboundResponseRouter.route(response);
  }

  /**
   * Handles notification messages with routing.
   * @param notification The JSON-RPC notification to send.
   */
  private async handleNotification(
    notification: JSONRPCMessage,
  ): Promise<void> {
    await this.outboundNotificationBroadcaster.broadcast(notification);
  }

  /**
   * Sends a notification to a specific client by their public key.
   * @param clientPubkey The public key of the target client.
   * @param notification The notification message to send.
   * @returns Promise that resolves when the notification is sent.
   */
  public async sendNotification(
    clientPubkey: string,
    notification: JSONRPCMessage,
    correlatedEventId?: string,
  ): Promise<void> {
    if (this.openStreamFactory.isClientEvicted(clientPubkey)) {
      throw new Error(`No active session found for client: ${clientPubkey}`);
    }

    const session = this.sessionStore.getSession(clientPubkey);
    if (!session) {
      throw new Error(`No active session found for client: ${clientPubkey}`);
    }

    const baseTags = this.createRecipientTags(clientPubkey);
    if (correlatedEventId) {
      baseTags.push([NOSTR_TAGS.EVENT_ID, correlatedEventId]);
    }

    const tags = this.capabilityNegotiator.buildOutboundTags({
      baseTags,
      session,
    });

    const giftWrapKind = this.capabilityNegotiator.chooseOutboundGiftWrapKind({
      session,
    });

    await this.sendMcpMessage(
      notification,
      clientPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      session.isEncrypted,
      undefined,
      giftWrapKind,
    );
  }

  /**
   * Processes incoming Nostr events, handling decryption and client authorization.
   * This method centralizes the logic for determining whether to process an event
   * based on encryption mode and allowed public keys.
   * @param event The incoming Nostr event.
   */
  private async processIncomingEvent(event: NostrEvent): Promise<void> {
    const unwrapped = await this.eventPipeline.unwrap(event);
    if (unwrapped) {
      const mcpMessage = this.convertNostrEventToMcpMessage(unwrapped.event);
      if (!mcpMessage) {
        this.logger.error(
          'Skipping invalid Nostr event with malformed JSON content',
          {
            eventId: unwrapped.event.id,
            pubkey: unwrapped.event.pubkey,
            content: unwrapped.event.content,
          },
        );
        return;
      }
      await this.inboundCoordinator.authorizeAndProcessEvent(
        unwrapped.event,
        unwrapped.isEncrypted,
        mcpMessage,
        unwrapped.wrapKind,
      );
    }
  }


  /**
   * Test-only accessor for internal state.
   * @internal
   */
  getInternalStateForTesting() {
    return {
      sessionStore: this.sessionStore,
      correlationStore: this.correlationStore,
      oversizedReceiver: this.oversizedReceiver,
      openStreamReceiver: this.openStreamFactory.getReceiver(),
      openStreamWriters: this.openStreamFactory.getWritersMap(),
      pendingOpenStreamResponses: this.openStreamFactory.getPendingResponsesMap(),
    };
  }
}
