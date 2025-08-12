import {
  InitializeResultSchema,
  NotificationSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CTXVM_MESSAGES_KIND,
  GIFT_WRAP_KIND,
  decryptMessage,
} from '../core/index.js';
import {
  BaseNostrTransport,
  BaseNostrTransportOptions,
} from './base-nostr-transport.js';
import { getNostrEventTag } from '../core/utils/serializers.js';
import { NostrEvent } from 'nostr-tools';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('nostr-client-transport');

/**
 * Options for configuring the NostrClientTransport.
 */
export interface NostrTransportOptions extends BaseNostrTransportOptions {
  serverPubkey: string;
}

/**
 * A transport layer for CTXVM that uses Nostr events for communication.
 * It implements the Transport interface from the @modelcontextprotocol/sdk.
 */
export class NostrClientTransport
  extends BaseNostrTransport
  implements Transport
{
  // Public event handlers required by the Transport interface.
  public onmessage?: (message: JSONRPCMessage) => void;
  public onclose?: () => void;
  public onerror?: (error: Error) => void;

  // Private properties for managing the transport's state and dependencies.
  private readonly serverPubkey: string;
  private readonly pendingRequestIds: Set<string>;
  private serverInitializeEvent: NostrEvent | undefined = undefined;

  constructor(options: NostrTransportOptions) {
    super(options);
    this.serverPubkey = options.serverPubkey;
    this.pendingRequestIds = new Set();
  }

  /**
   * Starts the transport, connecting to the relay and setting up event listeners.
   */
  public async start(): Promise<void> {
    await this.connect();
    const pubkey = await this.getPublicKey();
    const filters = this.createSubscriptionFilters(pubkey);

    await this.subscribe(filters, this.processIncomingEvent.bind(this));
  }

  /**
   * Closes the transport, disconnecting from the relay.
   */
  public async close(): Promise<void> {
    await this.disconnect();
    this.onclose?.();
  }

  /**
   * Sends a JSON-RPC message over the Nostr transport.
   * @param message The JSON-RPC request or response to send.
   */
  public async send(message: JSONRPCMessage): Promise<void> {
    const eventId = await this._sendInternal(message);
    if (eventId) {
      this.pendingRequestIds.add(eventId);
    }
  }

  /**
   * Internal method to send a JSON-RPC message and get the resulting event ID.
   * @param message The JSON-RPC message to send.
   * @returns The ID of the published Nostr event.
   */
  private async _sendInternal(message: JSONRPCMessage): Promise<string> {
    const tags = this.createRecipientTags(this.serverPubkey);

    return this.sendMcpMessage(
      message,
      this.serverPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
    );
  }

  /**
   * Processes incoming Nostr events, routing them to the correct handler.
   */
  private async processIncomingEvent(event: NostrEvent): Promise<void> {
    try {
      if (getNostrEventTag(event.tags, 'p') !== (await this.getPublicKey())) {
        logger.debug('Skipping event with unexpected pubkey:', event.pubkey);
        return;
      }
      let nostrEvent = event;

      // Handle encrypted messages
      if (event.kind === GIFT_WRAP_KIND) {
        const decryptedContent = await decryptMessage(event, this.signer);
        nostrEvent = JSON.parse(decryptedContent) as NostrEvent;
      }

      if (!this.serverInitializeEvent) {
        try {
          const content = JSON.parse(nostrEvent.content);
          const parse = InitializeResultSchema.safeParse(content.result);
          if (parse.success) {
            this.serverInitializeEvent = nostrEvent;
          }
        } catch (error) {
          logger.warn('Failed to parse server initialize event:', error);
        }
      }

      // Process the resulting event
      const mcpMessage = this.convertNostrEventToMcpMessage(nostrEvent);

      if (!mcpMessage) {
        logger.error(
          'Skipping invalid Nostr event with malformed JSON content',
        );
        return;
      }

      const eTag = getNostrEventTag(nostrEvent.tags, 'e');

      if (eTag) {
        this.handleResponse(eTag, mcpMessage);
      } else {
        this.handleNotification(mcpMessage);
      }
    } catch (error) {
      logger.error('Error handling incoming Nostr event:', error);
      this.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle incoming Nostr event'),
      );
    }
  }

  /**
   * Get the server initialize event
   */
  public getServerInitializeEvent(): NostrEvent | undefined {
    return this.serverInitializeEvent;
  }

  /**
   * Handles response messages by correlating them with pending requests.
   * @param correlatedEventId The event ID from the 'e' tag.
   * @param mcpMessage The incoming MCP message.
   */
  private handleResponse(
    correlatedEventId: string,
    mcpMessage: JSONRPCMessage,
  ): void {
    if (this.pendingRequestIds.has(correlatedEventId)) {
      this.onmessage?.(mcpMessage);
      this.pendingRequestIds.delete(correlatedEventId);
    } else {
      logger.error(
        `Received Nostr event with unexpected 'e' tag: ${correlatedEventId}.`,
      );
    }
  }

  /**
   * Handles notification messages.
   * @param mcpMessage The incoming MCP message.
   */
  private handleNotification(mcpMessage: JSONRPCMessage): void {
    try {
      NotificationSchema.parse(mcpMessage);
      this.onmessage?.(mcpMessage);
    } catch (error) {
      this.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle incoming notification'),
      );
    }
  }
}
