import {
  InitializeResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ResourceUpdatedNotificationSchema,
  ListToolsResultSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  isJSONRPCRequest,
  isJSONRPCNotification,
  type JSONRPCMessage,
  type JSONRPCRequest,
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
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
  NOSTR_TAGS,
  NOTIFICATIONS_INITIALIZED_METHOD,
  decryptMessage,
  DEFAULT_LRU_SIZE,
} from '../core/index.js';
import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';
import { NostrEvent } from 'nostr-tools';
import { LogLevel } from '../core/utils/logger.js';
import { injectClientPubkey, withTimeout } from '../core/utils/utils.js';
import {
  CorrelationStore,
  type EventRoute,
} from './nostr-server/correlation-store.js';
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
import { learnPeerCapabilities } from './discovery-tags.js';
import {
  sendAcceptFrame,
  sendOversizedServerResponse,
} from './nostr-server/oversized-server-handler.js';

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
}

export type InboundMiddlewareFn = (
  message: JSONRPCMessage,
  ctx: { clientPubkey: string; clientPmis?: readonly string[] },
  forward: (message: JSONRPCMessage) => Promise<void>,
) => Promise<void>;

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
  private readonly resourceSubscriptionsByUri: Map<string, Map<string, string>>;
  private readonly authorizationPolicy: AuthorizationPolicy;
  private readonly announcementManager: AnnouncementManager;
  private readonly injectClientPubkey: boolean;
  private readonly onClientSessionEvicted:
    | ((ctx: {
        clientPubkey: string;
        session: ClientSession;
      }) => void | Promise<void>)
    | undefined;
  private readonly inboundMiddlewares: InboundMiddlewareFn[] = [];

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

  constructor(options: NostrServerTransportOptions) {
    super('nostr-server-transport', options);
    this.injectClientPubkey = options.injectClientPubkey ?? false;
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

        this.removeResourceSubscriptionsForClient(clientPubkey);

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

    this.resourceSubscriptionsByUri = new Map<string, Map<string, string>>();

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

    // Advertise CEP-22 support so clients can skip the accept handshake.
    if (this.oversizedEnabled) {
      this.announcementManager.setInternalCommonTags([
        [NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER],
      ]);
    }
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
      this.resourceSubscriptionsByUri.clear();
      this.seenEventIds.clear();
      this.oversizedReceiver.clear();
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

  private takePendingServerDiscoveryTags(session: ClientSession): string[][] {
    if (session.hasSentCommonTags) {
      return [];
    }

    session.hasSentCommonTags = true;
    return this.announcementManager.getCommonTags();
  }

  private buildServerOutboundTags(params: {
    baseTags: readonly string[][];
    session: ClientSession;
    includeDiscovery?: boolean;
    negotiationTags?: readonly string[][];
  }): string[][] {
    const {
      baseTags,
      session,
      includeDiscovery = true,
      negotiationTags = [],
    } = params;

    return this.composeOutboundTags({
      baseTags,
      discoveryTags: includeDiscovery
        ? this.takePendingServerDiscoveryTags(session)
        : [],
      negotiationTags,
    });
  }

  private chooseServerOutboundGiftWrapKind(params: {
    session: ClientSession;
    fallbackWrapKind?: number;
  }): number | undefined {
    const { session, fallbackWrapKind } = params;

    if (!session.isEncrypted) {
      return undefined;
    }

    if (this.giftWrapMode === GiftWrapMode.EPHEMERAL) {
      return EPHEMERAL_GIFT_WRAP_KIND;
    }

    if (this.giftWrapMode === GiftWrapMode.PERSISTENT) {
      return GIFT_WRAP_KIND;
    }

    if (session.supportsEphemeralEncryption) {
      return EPHEMERAL_GIFT_WRAP_KIND;
    }

    return fallbackWrapKind;
  }

  private getRelayUrls(relayHandler: RelayHandler): string[] | undefined {
    return relayHandler.getRelayUrls?.();
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
   * Handles incoming requests with correlation tracking.
   * @param eventId The Nostr event ID.
   * @param request The request message.
   * @param clientPubkey The client's public key.
   */
  private handleIncomingRequest(
    eventId: string,
    request: JSONRPCRequest,
    clientPubkey: string,
    wrapKind?: number,
  ): void {
    // Store the original request ID for later restoration
    const originalRequestId = request.id;
    // Use the unique Nostr event ID as the MCP request ID to avoid collisions
    request.id = eventId;

    // Register the event route in the correlation store
    const progressToken = request.params?._meta?.progressToken;
    const parsedSubscribeRequest = SubscribeRequestSchema.safeParse(request);
    const parsedUnsubscribeRequest = UnsubscribeRequestSchema.safeParse(request);
    const resourceUri =
      parsedSubscribeRequest.success || parsedUnsubscribeRequest.success
        ? request.params?.uri
        : undefined;

    this.correlationStore.registerEventRoute(
      eventId,
      clientPubkey,
      originalRequestId,
      progressToken ? String(progressToken) : undefined,
      wrapKind,
      request.method,
      typeof resourceUri === 'string' ? resourceUri : undefined,
    );
  }

  private registerResourceSubscription(
    clientPubkey: string,
    resourceUri: string,
    correlatedEventId: string,
  ): void {
    let subscribers = this.resourceSubscriptionsByUri.get(resourceUri);
    if (!subscribers) {
      subscribers = new Map<string, string>();
      this.resourceSubscriptionsByUri.set(resourceUri, subscribers);
    }

    subscribers.set(clientPubkey, correlatedEventId);
  }

  private unregisterResourceSubscription(
    clientPubkey: string,
    resourceUri: string,
  ): void {
    const subscribers = this.resourceSubscriptionsByUri.get(resourceUri);
    if (!subscribers) {
      return;
    }

    subscribers.delete(clientPubkey);
    if (subscribers.size === 0) {
      this.resourceSubscriptionsByUri.delete(resourceUri);
    }
  }

  private removeResourceSubscriptionsForClient(clientPubkey: string): void {
    for (const [resourceUri, subscribers] of this.resourceSubscriptionsByUri) {
      subscribers.delete(clientPubkey);
      if (subscribers.size === 0) {
        this.resourceSubscriptionsByUri.delete(resourceUri);
      }
    }
  }

  private getResourceSubscribers(resourceUri: string): Array<{
    clientPubkey: string;
    correlatedEventId: string;
  }> {
    const subscribers = this.resourceSubscriptionsByUri.get(resourceUri);
    if (!subscribers) {
      return [];
    }

    return Array.from(
      subscribers,
      ([clientPubkey, correlatedEventId]) => ({
        clientPubkey,
        correlatedEventId,
      }),
    );
  }

  private applyResourceSubscriptionResult(
    route: EventRoute,
    nostrEventId: string,
    response: JSONRPCResponse | JSONRPCErrorResponse,
  ): void {
    if (!isJSONRPCResultResponse(response) || !route.resourceUri) {
      return;
    }

    if (route.requestMethod === 'resources/subscribe') {
      this.registerResourceSubscription(
        route.clientPubkey,
        route.resourceUri,
        nostrEventId,
      );
      return;
    }

    if (route.requestMethod === 'resources/unsubscribe') {
      this.unregisterResourceSubscription(route.clientPubkey, route.resourceUri);
    }
  }

  /**
   * Handles incoming notifications.
   * @param clientPubkey The client's public key.
   * @param notification The notification message.
   */
  private handleIncomingNotification(
    clientPubkey: string,
    notification: JSONRPCMessage,
  ): void {
    if (
      isJSONRPCNotification(notification) &&
      notification.method === NOTIFICATIONS_INITIALIZED_METHOD
    ) {
      this.sessionStore.markInitialized(clientPubkey);
    }
  }

  /**
   * Handles response messages by finding the original request and routing back to client.
   * @param response The JSON-RPC response or error to send.
   */
  private async handleResponse(
    response: JSONRPCResponse | JSONRPCErrorResponse,
  ): Promise<void> {
    // Handle special announcement responses
    if (response.id === 'announcement') {
      const wasHandled =
        await this.announcementManager.handleAnnouncementResponse(response);
      if (wasHandled && isJSONRPCResultResponse(response)) {
        if (InitializeResultSchema.safeParse(response.result).success) {
          this.logger.info('Initialized');
        }
      }
      return;
    }

    // Find the event route using O(1) lookup
    const nostrEventId = response.id as string;
    const route = this.correlationStore.popEventRoute(nostrEventId);

    if (!route) {
      this.onerror?.(
        new Error(`No pending request found for response ID: ${response.id}`),
      );
      return;
    }

    const session = this.sessionStore.getSession(route.clientPubkey);
    if (!session) {
      this.onerror?.(
        new Error(`No session found for client: ${route.clientPubkey}`),
      );
      return;
    }

    this.applyResourceSubscriptionResult(route, nostrEventId, response);

    // Restore the original request ID in the response
    response.id = route.originalRequestId;

    // CEP-22 Oversized Transfer (proactive path for server responses)
    if (
      this.oversizedEnabled &&
      route.progressToken &&
      session.supportsOversizedTransfer
    ) {
      // Serialize before restoring id so the client receives the correct id.
      const serialized = JSON.stringify(response);
      const byteLength = new TextEncoder().encode(serialized).byteLength;
      if (byteLength > this.oversizedThreshold) {
        const continuationFrameTags = this.createResponseTags(
          route.clientPubkey,
          nostrEventId,
        );
        const startFrameTags = this.buildServerOutboundTags({
          baseTags: continuationFrameTags,
          session,
        });
        const giftWrapKind = this.chooseServerOutboundGiftWrapKind({
          session,
          fallbackWrapKind: route.wrapKind,
        });

        await sendOversizedServerResponse(
          {
            serialized,
            clientPubkey: route.clientPubkey,
            progressToken: route.progressToken,
            startFrameTags,
            continuationFrameTags,
            isEncrypted: session.isEncrypted,
            giftWrapKind,
          },
          {
            chunkSizeBytes: this.oversizedChunkSize,
          },
          {
            sendMcpMessage: this.sendMcpMessage.bind(this),
            logger: this.logger,
          },
        );
        return;
      }
    }

    // Send the response back to the original requester
    const tags = this.buildServerOutboundTags({
      baseTags: this.createResponseTags(route.clientPubkey, nostrEventId),
      session,
    });

    const giftWrapKind = this.chooseServerOutboundGiftWrapKind({
      session,
      fallbackWrapKind: route.wrapKind,
    });

    // Attach pricing tags to capability list responses so clients can access CEP-8 pricing
    if (isJSONRPCResultResponse(response)) {
      const result = response.result;
      if (
        ListToolsResultSchema.safeParse(result).success ||
        ListResourcesResultSchema.safeParse(result).success ||
        ListResourceTemplatesResultSchema.safeParse(result).success ||
        ListPromptsResultSchema.safeParse(result).success
      ) {
        tags.push(...this.announcementManager.getPricingTags());
      }
    }

    await this.sendMcpMessage(
      response,
      route.clientPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      session.isEncrypted,
      undefined,
      giftWrapKind,
    );
  }

  /**
   * Handles notification messages with routing.
   * @param notification The JSON-RPC notification to send.
   */
  private async handleNotification(
    notification: JSONRPCMessage,
  ): Promise<void> {
    try {
      // Special handling for progress notifications
      if (
        isJSONRPCNotification(notification) &&
        notification.method === 'notifications/progress' &&
        notification.params?.progressToken
      ) {
        const token = String(notification.params.progressToken);

        // Use O(1) lookup for progress token routing
        const nostrEventId =
          this.correlationStore.getEventIdByProgressToken(token);

        if (nostrEventId) {
          const route = this.correlationStore.getEventRoute(nostrEventId);
          if (route) {
            await this.sendNotification(
              route.clientPubkey,
              notification,
              nostrEventId,
            );
            return;
          }
        }

        const error = new Error(`No client found for progress token: ${token}`);
        this.logger.error('Progress token not found', { token });
        this.onerror?.(error);
        return;
      }

      // `notifications/resources/updated` must be delivered only to correlated
      // subscribers, never via the generic broadcast fan-out.
      if (
        isJSONRPCNotification(notification) &&
        notification.method === 'notifications/resources/updated'
      ) {
        const parsedNotification =
          ResourceUpdatedNotificationSchema.safeParse(notification);

        if (!parsedNotification.success) {
          this.logger.warn('Invalid resources/updated notification payload', {
            notification,
          });
          return;
        }

        const resourceUri = parsedNotification.data.params.uri;
        const progressToken = parsedNotification.data.params._meta?.progressToken;

        if (progressToken !== undefined) {
          const token = String(progressToken);
          const nostrEventId =
            this.correlationStore.getEventIdByProgressToken(token);

          if (nostrEventId) {
            const route = this.correlationStore.getEventRoute(nostrEventId);
            if (route) {
              await this.sendNotification(
                route.clientPubkey,
                notification,
                nostrEventId,
              );
              return;
            }
          }
        }

        const subscribers = this.getResourceSubscribers(resourceUri).filter(
          ({ clientPubkey }) => {
            const session = this.sessionStore.getSession(clientPubkey);
            return !!session?.isInitialized;
          },
        );

        if (subscribers.length === 0) {
          this.logger.debug(
            'Dropping resources/updated notification with no correlated subscribers',
            { resourceUri },
          );
          return;
        }

        await Promise.all(
          subscribers.map(async ({ clientPubkey, correlatedEventId }) => {
            try {
              await this.sendNotification(
                clientPubkey,
                notification,
                correlatedEventId,
              );
            } catch (error) {
              this.logger.error('Error sending resources/updated notification', {
                error: error instanceof Error ? error.message : String(error),
                clientPubkey,
                resourceUri,
              });
            }
          }),
        );

        return;
      }

      // Use TaskQueue for outbound notification broadcasting to prevent event loop blocking
      for (const [
        clientPubkey,
        session,
      ] of this.sessionStore.getAllSessions()) {
        if (session.isInitialized) {
          this.taskQueue.add(async () => {
            try {
              await this.sendNotification(clientPubkey, notification);
            } catch (error) {
              this.logger.error('Error sending notification', {
                error: error instanceof Error ? error.message : String(error),
                clientPubkey,
                method: isJSONRPCNotification(notification)
                  ? notification.method
                  : 'unknown',
              });
            }
          });
        }
      }
    } catch (error) {
      this.logger.error('Error in handleNotification', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
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
    const session = this.sessionStore.getSession(clientPubkey);
    if (!session) {
      throw new Error(`No active session found for client: ${clientPubkey}`);
    }

    const baseTags = this.createRecipientTags(clientPubkey);
    if (correlatedEventId) {
      baseTags.push([NOSTR_TAGS.EVENT_ID, correlatedEventId]);
    }

    const tags = this.buildServerOutboundTags({
      baseTags,
      session,
    });

    const giftWrapKind = this.chooseServerOutboundGiftWrapKind({
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
    try {
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

        await this.handleEncryptedEvent(event);
      } else {
        await this.handleUnencryptedEvent(event);
      }
    } catch (error) {
      this.logger.error('Error in processIncomingEvent', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        eventKind: event.kind,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handles encrypted (gift-wrapped) events.
   * @param event The incoming gift-wrapped Nostr event.
   */
  private async handleEncryptedEvent(event: NostrEvent): Promise<void> {
    if (this.encryptionMode === EncryptionMode.DISABLED) {
      this.logger.error(
        `Received encrypted message from ${event.pubkey} but encryption is disabled. Ignoring.`,
      );
      return;
    }
    try {
      const decryptedJson = await withTimeout(
        decryptMessage(event, this.signer),
        DEFAULT_TIMEOUT_MS,
        'Decrypt message timed out',
      );
      const currentEvent = JSON.parse(decryptedJson) as NostrEvent;

      await this.authorizeAndProcessEvent(currentEvent, true, event.kind);
    } catch (error) {
      this.logger.error('Failed to handle encrypted Nostr event', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
      });
      this.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle encrypted Nostr event'),
      );
    }
  }

  /**
   * Handles unencrypted events.
   * @param event The incoming Nostr event.
   */
  private async handleUnencryptedEvent(event: NostrEvent): Promise<void> {
    if (this.encryptionMode === EncryptionMode.REQUIRED) {
      this.logger.error(
        `Received unencrypted message from ${event.pubkey} but encryption is required. Ignoring.`,
      );
      return;
    }
    await this.authorizeAndProcessEvent(event, false);
  }

  /**
   * Authorizes and processes an incoming Nostr event, handling message validation,
   * client authorization, session management, and optional client public key injection.
   * @param event The Nostr event to process.
   * @param isEncrypted Whether the original event was encrypted.
   */
  private async authorizeAndProcessEvent(
    event: NostrEvent,
    isEncrypted: boolean,
    wrapKind?: number,
  ): Promise<void> {
    try {
      const mcpMessage = this.convertNostrEventToMcpMessage(event);

      if (!mcpMessage) {
        this.logger.error(
          'Skipping invalid Nostr event with malformed JSON content',
          {
            eventId: event.id,
            pubkey: event.pubkey,
            content: event.content,
          },
        );
        return;
      }

      // Check authorization using the authorization policy
      const authDecision = await this.authorizationPolicy.authorize(
        event.pubkey,
        mcpMessage,
      );

      if (!authDecision.allowed) {
        this.logger.error(
          `Unauthorized message from ${event.pubkey}, message: ${JSON.stringify(mcpMessage)}. Ignoring.`,
        );

        if (
          'shouldReplyUnauthorized' in authDecision &&
          authDecision.shouldReplyUnauthorized &&
          isJSONRPCRequest(mcpMessage)
        ) {
          const errorResponse: JSONRPCErrorResponse = {
            jsonrpc: '2.0',
            id: mcpMessage.id,
            error: {
              code: -32000,
              message: 'Unauthorized',
            },
          };

          const tags = this.createResponseTags(event.pubkey, event.id);
          this.sendMcpMessage(
            errorResponse,
            event.pubkey,
            CTXVM_MESSAGES_KIND,
            tags,
            isEncrypted,
            undefined,
            isEncrypted
              ? this.giftWrapMode === GiftWrapMode.EPHEMERAL
                ? EPHEMERAL_GIFT_WRAP_KIND
                : this.giftWrapMode === GiftWrapMode.PERSISTENT
                  ? GIFT_WRAP_KIND
                  : wrapKind
              : undefined,
          ).catch((err) => {
            this.logger.error('Failed to send unauthorized response', {
              error: err instanceof Error ? err.message : String(err),
              pubkey: event.pubkey,
              eventId: event.id,
            });
            this.onerror?.(
              new Error(`Failed to send unauthorized response: ${err}`),
            );
          });
        }
        return;
      }

      const session = this.getOrCreateClientSession(event.pubkey, isEncrypted);
      const hadLearnedOversizedSupport = session.supportsOversizedTransfer;
      const discoveredCapabilities = learnPeerCapabilities(event.tags);
      session.supportsEncryption ||= discoveredCapabilities.supportsEncryption;
      session.supportsEphemeralEncryption ||=
        discoveredCapabilities.supportsEphemeralEncryption;
      session.supportsOversizedTransfer ||=
        this.oversizedEnabled &&
        discoveredCapabilities.supportsOversizedTransfer;

      const shouldSendAccept = !hadLearnedOversizedSupport;

      const forward = async (msg: JSONRPCMessage): Promise<void> => {
        this.onmessage?.(msg);
        this.onmessageWithContext?.(msg, {
          clientPubkey: event.pubkey,
        });
      };

      const clientPmis = event.tags
        .filter((tag) => tag[0] === 'pmi' && typeof tag[1] === 'string')
        .map((tag) => tag[1] as string);
      const ctx = {
        clientPubkey: event.pubkey,
        clientPmis: clientPmis.length > 0 ? clientPmis : undefined,
      };
      const middlewares = this.inboundMiddlewares;

      const dispatch = async (
        index: number,
        msg: JSONRPCMessage,
      ): Promise<void> => {
        const mw = middlewares[index];
        if (!mw) {
          await forward(msg);
          return;
        }
        await mw(msg, ctx, async (nextMsg) => {
          await dispatch(index + 1, nextMsg);
        });
      };

      if (isJSONRPCRequest(mcpMessage)) {
        this.handleIncomingRequest(
          event.id,
          mcpMessage,
          event.pubkey,
          wrapKind,
        );

        if (this.injectClientPubkey) {
          injectClientPubkey(mcpMessage, event.pubkey);
        }
      } else if (isJSONRPCNotification(mcpMessage)) {
        this.handleIncomingNotification(event.pubkey, mcpMessage);

        if (
          mcpMessage.method === 'notifications/progress' &&
          OversizedTransferReceiver.isOversizedFrame(mcpMessage)
        ) {
          this.oversizedReceiver
            .processFrame(mcpMessage)
            .then(async (synthetic) => {
              if (synthetic === null) {
                if (
                  (mcpMessage.params?.cvm as { frameType?: string } | undefined)
                    ?.frameType === 'start' &&
                  shouldSendAccept
                ) {
                  await sendAcceptFrame(
                    {
                      clientPubkey: event.pubkey,
                      progressToken: String(
                        mcpMessage.params?.progressToken ?? '',
                      ),
                    },
                    {
                      sendNotification: this.sendNotification.bind(this),
                    },
                  ).catch((err: unknown) => {
                    this.logger.error('Failed to send oversized accept', {
                      error: err instanceof Error ? err.message : String(err),
                    });
                  });
                }
                return;
              }

              if (isJSONRPCRequest(synthetic)) {
                this.handleIncomingRequest(
                  event.id,
                  synthetic,
                  event.pubkey,
                  wrapKind,
                );

                if (this.injectClientPubkey) {
                  injectClientPubkey(synthetic, event.pubkey);
                }
              } else if (isJSONRPCNotification(synthetic)) {
                this.handleIncomingNotification(event.pubkey, synthetic);
              }

              void dispatch(0, synthetic).catch((err: unknown) => {
                this.logger.error(
                  'Error dispatching reassembled oversized message',
                  {
                    error: err instanceof Error ? err.message : String(err),
                    pubkey: event.pubkey,
                  },
                );
                this.onerror?.(
                  err instanceof Error
                    ? err
                    : new Error('oversized dispatch failed'),
                );
              });
            })
            .catch((err: unknown) => {
              this.logger.error('Oversized transfer error (server)', {
                error: err instanceof Error ? err.message : String(err),
              });
              this.onerror?.(
                err instanceof Error ? err : new Error(String(err)),
              );
            });
          return;
        }
      }

      void dispatch(0, mcpMessage).catch((err: unknown) => {
        this.logger.error('Error in inboundMiddleware chain', {
          error: err instanceof Error ? err.message : String(err),
          eventId: event.id,
          pubkey: event.pubkey,
        });
        this.onerror?.(
          err instanceof Error ? err : new Error('inboundMiddleware failed'),
        );
      });
    } catch (error) {
      this.logger.error('Error in authorizeAndProcessEvent', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
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
    };
  }
}
