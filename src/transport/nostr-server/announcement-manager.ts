/**
 * Internal announcement manager for NostrServerTransport.
 * Handles public server announcements including initialization handshake,
 * schema mapping, and deletion events.
 *
 * This module is not exported from the public API.
 */

import {
  InitializeRequest,
  InitializeResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  type JSONRPCMessage,
  type JSONRPCResponse,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import type { Filter } from 'nostr-tools';
import { NostrEvent } from 'nostr-tools';
import { EventDeletion } from 'nostr-tools/kinds';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  announcementMethods,
  SERVER_ANNOUNCEMENT_KIND,
  TOOLS_LIST_KIND,
  RESOURCES_LIST_KIND,
  RESOURCETEMPLATES_LIST_KIND,
  PROMPTS_LIST_KIND,
  NOSTR_TAGS,
} from '../../core/index.js';
import { EncryptionMode } from '../../core/interfaces.js';

/**
 * Information about a server.
 */
export interface ServerInfo {
  name?: string;
  picture?: string;
  website?: string;
  about?: string;
}

/**
 * Options for configuring the AnnouncementManager.
 */
export interface AnnouncementManagerOptions {
  /** Server information to include in announcements */
  serverInfo?: ServerInfo;
  /** Encryption mode for determining tag inclusion */
  encryptionMode: EncryptionMode;
  /** Callback to send a message to the MCP server */
  onSendMessage: (message: JSONRPCMessage) => void;
  /** Callback to publish a Nostr event */
  onPublishEvent: (event: NostrEvent) => Promise<void>;
  /** Callback to sign an event */
  onSignEvent: (eventTemplate: NostrEvent) => Promise<NostrEvent>;
  /** Callback to get the server's public key */
  onGetPublicKey: () => Promise<string>;
  /** Callback to subscribe to relay events */
  onSubscribe: (
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
  ) => Promise<void>;
  /** Logger for debug output */
  logger: {
    info: (message: string, meta?: unknown) => void;
    warn: (message: string, meta?: unknown) => void;
    error: (message: string, meta?: unknown) => void;
    debug: (message: string, meta?: unknown) => void;
  };
}

/**
 * Schema-to-kind mapping for announcements.
 */
interface AnnouncementMapping {
  schema: {
    safeParse: (data: unknown) => { success: boolean };
  };
  kind: number;
  tags: string[][];
}

/**
 * Internal manager for public server announcements.
 *
 * This class encapsulates the announcement flow:
 * - Initialize handshake with timeout
 * - Schema-to-kind mapping for different announcement types
 * - Publishing announcements as Nostr events
 * - Deleting announcements via deletion events
 */
export class AnnouncementManager {
  private readonly serverInfo?: ServerInfo;
  private readonly encryptionMode: EncryptionMode;
  private readonly onSendMessage: (message: JSONRPCMessage) => void;
  private readonly onPublishEvent: (event: NostrEvent) => Promise<void>;
  private readonly onSignEvent: (
    eventTemplate: NostrEvent,
  ) => Promise<NostrEvent>;
  private readonly onGetPublicKey: () => Promise<string>;
  private readonly onSubscribe: (
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
  ) => Promise<void>;
  private readonly logger: AnnouncementManagerOptions['logger'];

  private isInitialized = false;
  private initializationPromise?: Promise<void>;
  private initializationResolver?: () => void;
  private cachedCommonTags?: string[][];

  constructor(options: AnnouncementManagerOptions) {
    this.serverInfo = options.serverInfo;
    this.encryptionMode = options.encryptionMode;
    this.onSendMessage = options.onSendMessage;
    this.onPublishEvent = options.onPublishEvent;
    this.onSignEvent = options.onSignEvent;
    this.onGetPublicKey = options.onGetPublicKey;
    this.onSubscribe = options.onSubscribe;
    this.logger = options.logger;
  }

  /**
   * Generates common tags from server information for use in Nostr events.
   * @returns Array of tag arrays for Nostr events.
   */
  getCommonTags(): string[][] {
    if (this.cachedCommonTags) {
      return this.cachedCommonTags;
    }

    const commonTags: string[][] = [];
    if (this.serverInfo?.name) {
      commonTags.push([NOSTR_TAGS.NAME, this.serverInfo.name]);
    }
    if (this.serverInfo?.about) {
      commonTags.push([NOSTR_TAGS.ABOUT, this.serverInfo.about]);
    }
    if (this.serverInfo?.website) {
      commonTags.push([NOSTR_TAGS.WEBSITE, this.serverInfo.website]);
    }
    if (this.serverInfo?.picture) {
      commonTags.push([NOSTR_TAGS.PICTURE, this.serverInfo.picture]);
    }
    if (this.encryptionMode !== EncryptionMode.DISABLED) {
      commonTags.push([NOSTR_TAGS.SUPPORT_ENCRYPTION]);
    }

    this.cachedCommonTags = commonTags;
    return commonTags;
  }

  /**
   * Gets the announcement mapping for schema-to-kind conversion.
   * @returns Array of announcement mappings.
   */
  private getAnnouncementMapping(): AnnouncementMapping[] {
    const commonTags = this.getCommonTags();

    return [
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
  }

  /**
   * Initiates the process of fetching announcement data from the server's internal logic.
   * This method properly handles the initialization handshake by first sending
   * the initialize request, waiting for the response, and then proceeding with other announcements.
   */
  async getAnnouncementData(): Promise<void> {
    try {
      const initializeParams: InitializeRequest['params'] = {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'DummyClient',
          version: '1.0.0',
        },
      };

      // Send the initialize request if not already initialized
      if (!this.isInitialized) {
        const initializeMessage: JSONRPCMessage = {
          jsonrpc: '2.0',
          id: 'announcement',
          method: 'initialize',
          params: initializeParams,
        };

        this.logger.info('Sending initialize request for announcement');
        this.onSendMessage(initializeMessage);
      }

      try {
        // Wait for initialization to complete
        await this.waitForInitialization();

        // Send all announcements now that we're initialized
        for (const [key, methodValue] of Object.entries(announcementMethods)) {
          this.logger.info('Sending announcement', { key, methodValue });
          const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 'announcement',
            method: methodValue,
            params: key === 'server' ? initializeParams : {},
          };
          this.onSendMessage(message);
        }
      } catch (error) {
        this.logger.warn(
          'Server not initialized after waiting, skipping announcements',
          { error: error instanceof Error ? error.message : error },
        );
      }
    } catch (error) {
      this.logger.error('Error in getAnnouncementData', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Waits for the server to be initialized with a timeout.
   * @returns Promise that resolves when initialized or after 10-second timeout.
   * The method will always resolve, allowing announcements to proceed.
   */
  private async waitForInitialization(): Promise<void> {
    if (this.isInitialized) return;

    if (!this.initializationPromise) {
      this.initializationPromise = new Promise((resolve) => {
        this.initializationResolver = resolve;
      });
    }

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Initialization timeout')), 10000),
    );

    try {
      await Promise.race([this.initializationPromise, timeout]);
    } catch {
      this.logger.warn(
        'Server initialization not completed within timeout, proceeding with announcements',
      );
    }
  }

  /**
   * Handles the JSON-RPC responses for public server announcements and publishes
   * them as Nostr events to the configured relays.
   * @param message The JSON-RPC response containing the announcement data.
   * @returns true if the message was an announcement response and was handled, false otherwise.
   */
  async handleAnnouncementResponse(message: JSONRPCResponse): Promise<boolean> {
    // Only process announcement responses
    if (message.id !== 'announcement') {
      return false;
    }

    if (!isJSONRPCResultResponse(message) || !message.result) {
      return true; // Was an announcement response, but no result
    }

    // Handle initialize response
    if (InitializeResultSchema.safeParse(message.result).success) {
      this.isInitialized = true;
      this.initializationResolver?.(); // Resolve waiting promise

      // Send the initialized notification
      const initializedNotification: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      };
      this.onSendMessage(initializedNotification);
      this.logger.info('Initialized');
    }

    // Publish the announcement as a Nostr event
    await this.publishAnnouncement(message.result as JSONRPCMessage);

    return true;
  }

  /**
   * Publishes an announcement as a Nostr event.
   * @param result The announcement result to publish.
   */
  private async publishAnnouncement(result: JSONRPCMessage): Promise<void> {
    try {
      const recipientPubkey = await this.onGetPublicKey();
      const announcementMapping = this.getAnnouncementMapping();

      for (const mapping of announcementMapping) {
        if (mapping.schema.safeParse(result).success) {
          const eventTemplate = {
            kind: mapping.kind,
            content: JSON.stringify(result),
            tags: mapping.tags,
            created_at: Math.floor(Date.now() / 1000),
            pubkey: recipientPubkey,
          };

          const signedEvent = await this.onSignEvent(
            eventTemplate as NostrEvent,
          );
          await this.onPublishEvent(signedEvent);
          this.logger.debug('Published announcement event', {
            kind: mapping.kind,
            eventId: signedEvent.id,
          });
          break;
        }
      }
    } catch (error) {
      this.logger.error('Error publishing announcement', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Deletes server announcements and capability listings by publishing deletion events.
   * This method queries for existing announcement events and publishes deletion events (kind 5)
   * to remove them from the relay network.
   * @param reason Optional reason for deletion (default: 'Service offline').
   * @returns Promise that resolves to an array of deletion events that were published.
   */
  async deleteAnnouncement(
    reason: string = 'Service offline',
  ): Promise<NostrEvent[]> {
    const publicKey = await this.onGetPublicKey();
    const allDeletedEvents: NostrEvent[] = [];

    const kinds = [
      SERVER_ANNOUNCEMENT_KIND,
      TOOLS_LIST_KIND,
      RESOURCES_LIST_KIND,
      RESOURCETEMPLATES_LIST_KIND,
      PROMPTS_LIST_KIND,
    ];

    for (const kind of kinds) {
      const eventsForKind: NostrEvent[] = [];
      const filter = {
        kinds: [kind],
        authors: [publicKey],
      };

      // Collect events for this specific kind
      await this.onSubscribe([filter], (event: NostrEvent) => {
        try {
          eventsForKind.push(event);
        } catch (error) {
          this.logger.error('Error in relay subscription event collection', {
            error: error instanceof Error ? error.message : String(error),
            eventId: event.id,
          });
        }
      });

      if (!eventsForKind.length) {
        this.logger.info(`No events found for kind ${kind} to delete`);
        continue;
      }

      const deletionEventTemplate = {
        kind: EventDeletion,
        pubkey: publicKey,
        content: reason,
        tags: eventsForKind.map((ev) => ['e', ev.id]),
        created_at: Math.floor(Date.now() / 1000),
      };

      const deletionEvent = await this.onSignEvent(
        deletionEventTemplate as NostrEvent,
      );

      await this.onPublishEvent(deletionEvent);
      this.logger.info(
        `Published deletion event for kind ${kind} (${eventsForKind.length} events)`,
      );

      allDeletedEvents.push(...eventsForKind);
    }
    return allDeletedEvents;
  }

  /**
   * Checks if the manager is initialized.
   */
  get initialized(): boolean {
    return this.isInitialized;
  }
}
