import {
  InitializeResultSchema,
  NotificationSchema,
  type JSONRPCMessage,
  isJSONRPCRequest,
  isJSONRPCNotification,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCResponse,
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
  isStateless?: boolean;
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
  private readonly isStateless: boolean;

  constructor(options: NostrTransportOptions) {
    super(options);
    this.serverPubkey = options.serverPubkey;
    this.pendingRequestIds = new Set();
    this.isStateless = options.isStateless ?? false;
  }

  /**
   * Starts the transport, connecting to the relay and setting up event listeners.
   */
  public async start(): Promise<void> {
    try {
      await this.connect();
      const pubkey = await this.getPublicKey();
      logger.info('Client pubkey:', pubkey);
      const filters = this.createSubscriptionFilters(pubkey);

      await this.subscribe(filters, async (event) => {
        try {
          await this.processIncomingEvent(event);
        } catch (error) {
          logger.error('Error processing incoming event', {
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
      logger.error('Error starting NostrClientTransport', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Closes the transport, disconnecting from the relay.
   */
  public async close(): Promise<void> {
    try {
      await this.disconnect();
      this.onclose?.();
    } catch (error) {
      logger.error('Error closing NostrClientTransport', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Sends a JSON-RPC message over the Nostr transport.
   * @param message The JSON-RPC request or response to send.
   */
  public async send(message: JSONRPCMessage): Promise<void> {
    try {
      if (this.isStateless) {
        if (isJSONRPCRequest(message) && message.method === 'initialize') {
          logger.info('Stateless mode: Emulating initialize response.');
          this.emulateInitializeResponse(message.id as string | number);
          return;
        }
        if (
          isJSONRPCNotification(message) &&
          message.method === 'notifications/initialized'
        ) {
          logger.info(
            'Stateless mode: Catching notifications/initialized.',
            message,
          );
          return;
        }
      }

      const eventId = await this._sendInternal(message);
      if (eventId) {
        this.pendingRequestIds.add(eventId);
      }
    } catch (error) {
      logger.error('Error sending message', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
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
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Emulates the server's initialize response for stateless clients.
   * This method constructs a generic server response and injects it back into the client,
   * allowing the client to self-initialize without a network roundtrip.
   * @param requestId The ID of the original initialize request.
   */
  private emulateInitializeResponse(requestId: string | number): void {
    try {
      const emulatedResult = {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        serverInfo: {
          name: 'Emulated-Stateless-Server',
          version: '1.0.0',
        },
        capabilities: {
          tools: {
            listChanged: true,
          },
          prompts: {
            listChanged: true,
          },
          resources: {
            subscribe: true,
            listChanged: true,
          },
        },
      };

      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: requestId,
        result: emulatedResult,
      };

      // Feed the emulated response back to the MCP client.
      // Use a setTimeout to avoid re-entrancy issues and mimic a slight network delay.
      setTimeout(() => {
        try {
          this.onmessage?.(response);
        } catch (error) {
          logger.error('Error in emulated initialize response callback', {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            requestId,
          });
          this.onerror?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }, 50);
    } catch (error) {
      logger.error('Error emulating initialize response', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        requestId,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Internal method to send a JSON-RPC message and get the resulting event ID.
   * @param message The JSON-RPC message to send.
   * @returns The ID of the published Nostr event.
   */
  private async _sendInternal(message: JSONRPCMessage): Promise<string> {
    try {
      const tags = this.createRecipientTags(this.serverPubkey);

      return this.sendMcpMessage(
        message,
        this.serverPubkey,
        CTXVM_MESSAGES_KIND,
        tags,
      );
    } catch (error) {
      logger.error('Error in _sendInternal', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        serverPubkey: this.serverPubkey,
      });
      throw error;
    }
  }

  /**
   * Processes incoming Nostr events, routing them to the correct handler.
   */
  private async processIncomingEvent(event: NostrEvent): Promise<void> {
    try {
      let nostrEvent = event;

      // Handle encrypted messages
      if (event.kind === GIFT_WRAP_KIND) {
        try {
          const decryptedContent = await decryptMessage(event, this.signer);
          nostrEvent = JSON.parse(decryptedContent) as NostrEvent;
        } catch (decryptError) {
          logger.error('Failed to decrypt gift-wrapped event', {
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

      // Check if the event is from the expected server
      if (nostrEvent.pubkey !== this.serverPubkey) {
        logger.debug('Skipping event from unexpected server pubkey:', {
          receivedPubkey: nostrEvent.pubkey,
          expectedPubkey: this.serverPubkey,
          eventId: nostrEvent.id,
        });
        return;
      }

      if (!this.serverInitializeEvent) {
        try {
          const content = JSON.parse(nostrEvent.content);
          const parse = InitializeResultSchema.safeParse(content.result);
          if (parse.success) {
            this.serverInitializeEvent = nostrEvent;
            logger.info('Received server initialize event', {
              eventId: nostrEvent.id,
            });
          }
        } catch (error) {
          logger.warn('Failed to parse server initialize event:', {
            error: error instanceof Error ? error.message : String(error),
            eventId: nostrEvent.id,
          });
        }
      }
      const eTag = getNostrEventTag(nostrEvent.tags, 'e');

      if (eTag && !this.pendingRequestIds.has(eTag)) {
        logger.error(`Received Nostr event with unexpected 'e' tag: ${eTag}.`, {
          eventId: nostrEvent.id,
          eTag,
        });
        return;
      }

      // Process the resulting event
      const mcpMessage = this.convertNostrEventToMcpMessage(nostrEvent);

      if (!mcpMessage) {
        logger.error(
          'Skipping invalid Nostr event with malformed JSON content',
          { eventId: nostrEvent.id, pubkey: nostrEvent.pubkey },
        );
        return;
      }

      if (eTag) {
        this.handleResponse(eTag, mcpMessage);
      } else {
        this.handleNotification(mcpMessage);
      }
    } catch (error) {
      logger.error('Error handling incoming Nostr event', {
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
    try {
      this.onmessage?.(mcpMessage);
      this.pendingRequestIds.delete(correlatedEventId);
    } catch (error) {
      logger.error('Error handling response', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        correlatedEventId,
      });
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
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
      logger.error('Failed to handle incoming notification', {
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
}
