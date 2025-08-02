import {
  InitializeRequest,
  InitializeResultSchema,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCNotification,
  JSONRPCError,
  LATEST_PROTOCOL_VERSION,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCResponse,
  isJSONRPCError,
  JSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  BaseNostrTransport,
  BaseNostrTransportOptions,
} from './base-nostr-transport.js';
import {
  announcementMethods,
  CTXVM_MESSAGES_KIND,
  GIFT_WRAP_KIND,
  NOSTR_TAGS,
  PROMPTS_LIST_KIND,
  RESOURCES_LIST_KIND,
  RESOURCETEMPLATES_LIST_KIND,
  SERVER_ANNOUNCEMENT_KIND,
  TOOLS_LIST_KIND,
  decryptMessage,
} from '../core/index.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrEvent } from 'nostr-tools';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('nostr-server-transport');

export interface PricingConfig {
  price: number;
  currency?: string;
}

/**
 * Configuration for capability pricing with currency support.
 */
export interface CapabilityPricingConfig {
  pricing: Map<string, PricingConfig>;
}

/**
 * Options for configuring the NostrServerTransport.
 */
export interface NostrServerTransportOptions extends BaseNostrTransportOptions {
  serverInfo?: ServerInfo;
  isPublicServer?: boolean;
  allowedPublicKeys?: string[];
  capabilityPricing?: CapabilityPricingConfig;
}

/**
 * Information about a server.
 */
export interface ServerInfo {
  name?: string;
  picture?: string;
  website?: string;
}

/**
 * Information about a connected client session with integrated request tracking.
 */
interface ClientSession {
  isInitialized: boolean;
  isEncrypted: boolean;
  lastActivity: number;
  pendingRequests: Map<string, string | number>;
}

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
  public onclose?: () => void;
  public onerror?: (error: Error) => void;

  private readonly clientSessions = new Map<string, ClientSession>();
  private readonly isPublicServer?: boolean;
  private readonly allowedPublicKeys?: string[];
  private readonly serverInfo?: ServerInfo;
  private readonly capabilityPricing?: CapabilityPricingConfig;

  constructor(options: NostrServerTransportOptions) {
    super(options);
    this.serverInfo = options.serverInfo;
    this.isPublicServer = options.isPublicServer;
    this.allowedPublicKeys = options.allowedPublicKeys;
    this.capabilityPricing = options.capabilityPricing;
  }

  /**
   * Starts the transport, connecting to the relay and setting up event listeners
   * to receive incoming MCP requests.
   */
  public async start(): Promise<void> {
    await this.connect();
    const pubkey = await this.getPublicKey();
    // Subscribe to events targeting this server's public key
    const filters = this.createSubscriptionFilters(pubkey);

    await this.subscribe(filters, this.processIncomingEvent.bind(this));

    if (this.isPublicServer) {
      this.getAnnouncementData();
    }
  }

  /**
   * Closes the transport, disconnecting from the relay.
   */
  public async close(): Promise<void> {
    await this.disconnect();
    this.clientSessions.clear();
    this.onclose?.();
  }

  /**
   * Sends JSON-RPC messages over the Nostr transport.
   * @param message The JSON-RPC message to send.
   */
  public async send(message: JSONRPCMessage): Promise<void> {
    // Message type detection and routing
    if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
      await this.handleResponse(message);
    } else if (isJSONRPCNotification(message)) {
      this.cleanupInactiveSessions();
      await this.handleNotification(message);
    } else {
      this.onerror?.(new Error('Unknown message type in send()'));
    }
  }

  /**
   * Initiates the process of fetching announcement data from the server's internal logic.
   */
  private getAnnouncementData(): void {
    const initializeParams: InitializeRequest['params'] = {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'DummyClient',
        version: '1.0.0',
      },
    };

    for (const [key, methodValue] of Object.entries(announcementMethods)) {
      const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 'announcement',
        method: methodValue,
        params: key === 'server' ? initializeParams : {},
      };

      this.onmessage?.(message);
    }
  }

  /**
   * Handles the JSON-RPC responses for public server announcements and publishes
   * them as Nostr events to the configured relays.
   * @param message The JSON-RPC response containing the announcement data.
   */
  private async announcer(message: JSONRPCResponse): Promise<void> {
    const recipientPubkey = await this.getPublicKey();
    const commonTags = [
      ...(this.serverInfo?.name
        ? [[NOSTR_TAGS.NAME, this.serverInfo.name]]
        : []),
      ...(this.serverInfo?.website
        ? [[NOSTR_TAGS.WEBSITE, this.serverInfo.website]]
        : []),
      ...(this.serverInfo?.picture
        ? [[NOSTR_TAGS.PICTURE, this.serverInfo.picture]]
        : []),
      ...(this.encryptionMode !== EncryptionMode.DISABLED
        ? [[NOSTR_TAGS.SUPPORT_ENCRYPTION]]
        : []),
    ];

    const announcementMapping = [
      {
        schema: InitializeResultSchema,
        kind: SERVER_ANNOUNCEMENT_KIND,
        tags: commonTags,
      },
      { schema: ListToolsResultSchema, kind: TOOLS_LIST_KIND, tags: [] },
      {
        schema: ListResourcesResultSchema,
        kind: RESOURCES_LIST_KIND,
        tags: [],
      },
      {
        schema: ListResourceTemplatesResultSchema,
        kind: RESOURCETEMPLATES_LIST_KIND,
        tags: [],
      },
      { schema: ListPromptsResultSchema, kind: PROMPTS_LIST_KIND, tags: [] },
    ];

    for (const mapping of announcementMapping) {
      if (mapping.schema.safeParse(message.result).success) {
        await this.sendMcpMessage(
          message.result as JSONRPCMessage,
          recipientPubkey,
          mapping.kind,
          mapping.tags,
        );
        break;
      }
    }
  }

  /**
   * Gets or creates a client session with proper initialization.
   * @param clientPubkey The client's public key.
   * @param now Current timestamp.
   * @returns The client session.
   */
  private getOrCreateClientSession(
    clientPubkey: string,
    now: number,
    isEncrypted: boolean,
  ): ClientSession {
    const session = this.clientSessions.get(clientPubkey);
    if (!session) {
      const newSession: ClientSession = {
        isInitialized: false,
        isEncrypted,
        lastActivity: now,
        pendingRequests: new Map(),
      };
      this.clientSessions.set(clientPubkey, newSession);
      return newSession;
    }
    session.isEncrypted = isEncrypted;
    return session;
  }

  /**
   * Handles incoming requests with correlation tracking.
   * @param session The client session.
   * @param eventId The Nostr event ID.
   * @param request The request message.
   */
  private handleIncomingRequest(
    session: ClientSession,
    eventId: string,
    request: JSONRPCRequest,
  ): void {
    // Store the original request ID for later restoration
    const originalRequestId = request.id;
    // Use the unique Nostr event ID as the MCP request ID to avoid collisions
    request.id = eventId;
    // Store in client session
    session.pendingRequests.set(eventId, originalRequestId);

    // Track progress tokens if provided
    const progressToken = request.params?._meta?.progressToken;
    if (progressToken) {
      session.pendingRequests.set(String(progressToken), eventId);
    }
  }

  /**
   * Handles incoming notifications.
   * @param session The client session.
   * @param notification The notification message.
   */
  private handleIncomingNotification(
    session: ClientSession,
    notification: JSONRPCMessage,
  ): void {
    if (
      isJSONRPCNotification(notification) &&
      notification.method === 'notifications/initialized'
    ) {
      session.isInitialized = true;
    }
  }

  /**
   * Handles response messages by finding the original request and routing back to client.
   * @param response The JSON-RPC response or error to send.
   */
  private async handleResponse(
    response: JSONRPCResponse | JSONRPCError,
  ): Promise<void> {
    // Handle special announcement responses
    if (response.id === 'announcement') {
      if (isJSONRPCResponse(response)) {
        await this.announcer(response);
      }
      return;
    }

    // Find the client session with this pending request
    const nostrEventId = response.id as string;
    let targetClientPubkey: string | undefined;
    let originalRequestId: string | number | undefined;

    for (const [clientPubkey, session] of this.clientSessions.entries()) {
      const originalId = session.pendingRequests.get(nostrEventId);
      if (originalId !== undefined) {
        targetClientPubkey = clientPubkey;
        originalRequestId = originalId;
        break;
      }
    }

    if (!targetClientPubkey || originalRequestId === undefined) {
      this.onerror?.(
        new Error(`No pending request found for response ID: ${response.id}`),
      );
      return;
    }

    // Restore the original request ID in the response
    response.id = originalRequestId;

    // Send the response back to the original requester
    const session = this.clientSessions.get(targetClientPubkey);
    if (!session) {
      this.onerror?.(
        new Error(`No session found for client: ${targetClientPubkey}`),
      );
      return;
    }
    const tags = this.createResponseTags(targetClientPubkey, nostrEventId);
    if (
      isJSONRPCResponse(response) &&
      InitializeResultSchema.safeParse(response.result).success &&
      session.isEncrypted
    ) {
      tags.push([NOSTR_TAGS.SUPPORT_ENCRYPTION]);
    }

    await this.sendMcpMessage(
      response,
      targetClientPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      session.isEncrypted,
    );

    // Clean up the pending request and any associated progress token
    if (session) {
      session.pendingRequests.delete(nostrEventId);

      // Find and delete the corresponding progress token if it exists
      let progressTokenToDelete: string | number | undefined;
      for (const [key, value] of session.pendingRequests.entries()) {
        if (value === nostrEventId) {
          progressTokenToDelete = key;
          break;
        }
      }
      if (progressTokenToDelete !== undefined) {
        session.pendingRequests.delete(String(progressTokenToDelete));
      }
    }
  }

  /**
   * Handles notification messages with routing.
   * @param notification The JSON-RPC notification to send.
   */
  private async handleNotification(
    notification: JSONRPCMessage,
  ): Promise<void> {
    // Special handling for progress notifications
    // TODO: Add handling for `notifications/resources/updated`, as they need to be associated with an id
    if (
      isJSONRPCNotification(notification) &&
      notification.method === 'notifications/progress' &&
      notification.params?._meta?.progressToken
    ) {
      const token = String(notification.params._meta.progressToken);

      for (const [clientPubkey, session] of this.clientSessions.entries()) {
        if (session.pendingRequests.has(token)) {
          const nostrEventId = session.pendingRequests.get(token) as string;
          await this.sendNotification(clientPubkey, notification, nostrEventId);
          return;
        }
      }

      this.onerror?.(new Error(`No client found for progress token: ${token}`));
      return;
    }

    const promises: Promise<void>[] = [];
    for (const [clientPubkey, session] of this.clientSessions.entries()) {
      if (session.isInitialized) {
        promises.push(this.sendNotification(clientPubkey, notification));
      }
    }

    await Promise.all(promises);
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
    const session = this.clientSessions.get(clientPubkey);
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
    );
  }

  /**
   * Processes incoming Nostr events, handling decryption and client authorization.
   * This method centralizes the logic for determining whether to process an event
   * based on encryption mode and allowed public keys.
   * @param event The incoming Nostr event.
   */
  private async processIncomingEvent(event: NostrEvent): Promise<void> {
    if (event.kind === GIFT_WRAP_KIND) {
      await this.handleEncryptedEvent(event);
    } else {
      this.handleUnencryptedEvent(event);
    }
  }

  /**
   * Handles encrypted (gift-wrapped) events.
   * @param event The incoming gift-wrapped Nostr event.
   */
  private async handleEncryptedEvent(event: NostrEvent): Promise<void> {
    if (this.encryptionMode === EncryptionMode.DISABLED) {
      logger.error(
        `Received encrypted message from ${event.pubkey} but encryption is disabled. Ignoring.`,
      );
      return;
    }
    try {
      const decryptedJson = await decryptMessage(event, this.signer);
      const currentEvent = JSON.parse(decryptedJson) as NostrEvent;
      this.authorizeAndProcessEvent(currentEvent, true);
    } catch (error) {
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
      logger.error(
        `Received unencrypted message from ${event.pubkey} but encryption is required. Ignoring.`,
      );
      return;
    }
    this.authorizeAndProcessEvent(event, false);
  }

  /**
   * Extracts the capability identifier from a JSON-RPC request.
   * @param request The JSON-RPC request to extract capability from.
   * @returns The capability identifier or undefined if not applicable.
   */
  private extractCapabilityIdentifier(
    request: JSONRPCRequest,
  ): string | undefined {
    const method = request.method;

    // Handle tools/call requests
    if (method === 'tools/call' && request.params?.name) {
      return request.params.name as string;
    }

    // Handle prompts/get requests
    if (method === 'prompts/get' && request.params?.name) {
      return request.params.name as string;
    }

    // Handle resources/read requests - use URI as identifier
    if (method === 'resources/read' && request.params?.uri) {
      return request.params.uri as string;
    }

    // Handle list methods - use the method name itself as identifier
    if (
      method.startsWith('tools/') ||
      method.startsWith('resources/') ||
      method.startsWith('prompts/')
    ) {
      return method;
    }

    return undefined;
  }

  /**
   * Common logic for authorizing and processing an event.
   * @param event The event to process.
   * @param isEncrypted Whether the original event was encrypted.
   */
  private authorizeAndProcessEvent(
    event: NostrEvent,
    isEncrypted: boolean,
  ): void {
    if (
      this.allowedPublicKeys?.length &&
      !this.allowedPublicKeys.includes(event.pubkey)
    ) {
      logger.error(`Unauthorized message from ${event.pubkey}. Ignoring.`);
      return;
    }

    const mcpMessage = this.convertNostrEventToMcpMessage(event);

    if (!mcpMessage) {
      logger.error('Skipping invalid Nostr event with malformed JSON content');
      return;
    }

    const now = Date.now();
    const session = this.getOrCreateClientSession(
      event.pubkey,
      now,
      isEncrypted,
    );
    session.lastActivity = now;

    // Check pricing for requests
    if (isJSONRPCRequest(mcpMessage)) {
      const capabilityId = this.extractCapabilityIdentifier(mcpMessage);

      if (capabilityId) {
        const hasPrice = this.hasCapabilityPrice(capabilityId);
        const price = this.getCapabilityPrice(capabilityId);

        logger.info(
          `Request for capability '${capabilityId}' from ${event.pubkey}: ` +
            `hasPrice=${hasPrice}, price=${price ?? 'N/A'}`,
        );

        // If the capability has a price, send a payment required notification
        if (hasPrice && price) {
          const notification: JSONRPCNotification = {
            jsonrpc: '2.0',
            method: 'payment_required',
            params: {
              price: price.price,
              currency: price.currency,
            },
          };
          this.sendNotification(event.pubkey, notification, event.id);
          return;
        }
      }
      this.handleIncomingRequest(session, event.id, mcpMessage);
    } else if (isJSONRPCNotification(mcpMessage)) {
      this.handleIncomingNotification(session, mcpMessage);
    }

    this.onmessage?.(mcpMessage);
  }

  /**
   * Cleans up inactive client sessions based on a timeout.
   * @param timeoutMs Timeout in milliseconds for considering a session inactive (default: 5 minutes).
   * @returns The number of sessions that were cleaned up.
   */
  public cleanupInactiveSessions(timeoutMs: number = 300000): number {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [clientPubkey, session] of this.clientSessions.entries()) {
      if (now - session.lastActivity > timeoutMs) {
        keysToDelete.push(clientPubkey);
      }
    }

    for (const key of keysToDelete) {
      this.clientSessions.delete(key);
    }

    return keysToDelete.length;
  }

  /**
   * Checks if a capability has an associated price.
   * @param capabilityName The name of the capability to check.
   * @returns True if the capability has a price, false otherwise.
   */
  public hasCapabilityPrice(capabilityName: string): boolean {
    return (
      this.capabilityPricing !== undefined &&
      this.capabilityPricing.pricing.has(capabilityName)
    );
  }

  /**
   * Gets the price for a specific capability.
   * @param capabilityName The name of the capability.
   * @returns The price in the configured currency unit, or undefined if no price is set.
   */
  public getCapabilityPrice(capabilityName: string): PricingConfig | undefined {
    return this.capabilityPricing?.pricing.get(capabilityName);
  }
}
