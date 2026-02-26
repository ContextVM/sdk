import {
  InitializeResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
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
import { CorrelationStore } from './nostr-server/correlation-store.js';
import { ClientSession, SessionStore } from './nostr-server/session-store.js';
import { LruCache } from '../core/utils/lru-cache.js';
import {
  AuthorizationPolicy,
  CapabilityExclusion,
} from './nostr-server/authorization-policy.js';
import {
  AnnouncementManager,
  ServerInfo,
} from './nostr-server/announcement-manager.js';

/**
 * Options for configuring the NostrServerTransport.
 */
export interface NostrServerTransportOptions extends BaseNostrTransportOptions {
  serverInfo?: ServerInfo;
  isPublicServer?: boolean;
  allowedPublicKeys?: string[];
  /** List of capabilities that are excluded from public key whitelisting requirements */
  excludedCapabilities?: CapabilityExclusion[];
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
      excludedCapabilities: options.excludedCapabilities,
      isPublicServer: options.isPublicServer,
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
      encryptionMode: this.encryptionMode,
      giftWrapMode: this.giftWrapMode,
      extraCommonTags: [],
      pricingTags: [],
      onSendMessage: (message) => this.onmessage?.(message),
      onPublishEvent: (event) => this.publishEvent(event),
      onSignEvent: (eventTemplate) => this.signer.signEvent(eventTemplate),
      onGetPublicKey: () => this.getPublicKey(),
      onSubscribe: (filters, onEvent) =>
        this.relayHandler.subscribe(filters, onEvent).then(() => undefined),
      logger: this.logger,
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

      if (this.authorizationPolicy.isPublicServer) {
        await this.announcementManager.getAnnouncementData();
      }
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
    this.correlationStore.registerEventRoute(
      eventId,
      clientPubkey,
      originalRequestId,
      progressToken ? String(progressToken) : undefined,
      wrapKind,
    );
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

    // Restore the original request ID in the response
    response.id = route.originalRequestId;

    // Send the response back to the original requester
    const tags = this.createResponseTags(route.clientPubkey, nostrEventId);

    // Attach transport capability tags on the first response for a client session.
    // This enables capability discovery (e.g. support_encryption_ephemeral) even when
    // clients operate in stateless mode and never observe a real initialize handshake.
    if (!session.hasSentCommonTags) {
      tags.push(...this.announcementManager.getCapabilityTags());
      session.hasSentCommonTags = true;
    }

    let giftWrapKind: number | undefined;
    if (session.isEncrypted) {
      if (this.giftWrapMode === GiftWrapMode.OPTIONAL) {
        giftWrapKind = route.wrapKind;
      } else if (this.giftWrapMode === GiftWrapMode.EPHEMERAL) {
        giftWrapKind = EPHEMERAL_GIFT_WRAP_KIND;
      } else if (this.giftWrapMode === GiftWrapMode.PERSISTENT) {
        giftWrapKind = GIFT_WRAP_KIND;
      }
    }

    // Add server metadata tags for initialize responses (independent of encryption mode).
    // Capability tags are already sent on the first response via `hasSentCommonTags`.
    if (
      isJSONRPCResultResponse(response) &&
      InitializeResultSchema.safeParse(response.result).success
    ) {
      const serverInfoTags = this.announcementManager.getServerInfoTags();
      serverInfoTags.forEach((tag) => {
        tags.push(tag);
      });
    }

    // Attach pricing tags to capability list responses so clients can access CEP-8 pricing
    if (isJSONRPCResultResponse(response)) {
      const result = response.result;
      if (
        ListToolsResultSchema.safeParse(result).success ||
        ListResourcesResultSchema.safeParse(result).success ||
        ListResourceTemplatesResultSchema.safeParse(result).success ||
        ListPromptsResultSchema.safeParse(result).success
      ) {
        const pricingTags = this.announcementManager.getPricingTags();
        pricingTags.forEach((tag) => {
          tags.push(tag);
        });
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
      // TODO: Add handling for `notifications/resources/updated`, as they need to be associated with an id
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

    // Create tags for targeting the specific client
    const tags = this.createRecipientTags(clientPubkey);
    if (correlatedEventId) {
      tags.push([NOSTR_TAGS.EVENT_ID, correlatedEventId]);
    }

    await this.sendMcpMessage(
      notification,
      clientPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      session.isEncrypted,
      undefined,
      session.isEncrypted
        ? this.giftWrapMode === GiftWrapMode.EPHEMERAL
          ? EPHEMERAL_GIFT_WRAP_KIND
          : this.giftWrapMode === GiftWrapMode.PERSISTENT
            ? GIFT_WRAP_KIND
            : undefined
        : undefined,
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
        this.handleUnencryptedEvent(event);
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

      this.authorizeAndProcessEvent(currentEvent, true, event.kind);
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
  private handleUnencryptedEvent(event: NostrEvent): void {
    if (this.encryptionMode === EncryptionMode.REQUIRED) {
      this.logger.error(
        `Received unencrypted message from ${event.pubkey} but encryption is required. Ignoring.`,
      );
      return;
    }
    this.authorizeAndProcessEvent(event, false);
  }

  /**
   * Authorizes and processes an incoming Nostr event, handling message validation,
   * client authorization, session management, and optional client public key injection.
   * @param event The Nostr event to process.
   * @param isEncrypted Whether the original event was encrypted.
   */
  private authorizeAndProcessEvent(
    event: NostrEvent,
    isEncrypted: boolean,
    wrapKind?: number,
  ): void {
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
      const authDecision = this.authorizationPolicy.authorize(
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

      // Get or create session for this client (ensures session exists for authorized messages)
      this.getOrCreateClientSession(event.pubkey, isEncrypted);

      // Handle message routing and conditionally inject client pubkey
      if (isJSONRPCRequest(mcpMessage)) {
        this.handleIncomingRequest(
          event.id,
          mcpMessage,
          event.pubkey,
          wrapKind,
        );

        // Inject client public key for enhanced server integration (in-place mutation)
        if (this.injectClientPubkey) {
          injectClientPubkey(mcpMessage, event.pubkey);
        }
      } else if (isJSONRPCNotification(mcpMessage)) {
        this.handleIncomingNotification(event.pubkey, mcpMessage);
      }

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
