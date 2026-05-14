import {
  InitializeResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  type JSONRPCMessage,
  isJSONRPCResultResponse,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { type NostrEvent } from 'nostr-tools';
import { type Logger } from '../../core/utils/logger.js';
import { getNostrEventTag } from '../../core/utils/serializers.js';
import {
  type ClientCapabilityNegotiator,
  parseDiscoveredPeerCapabilities,
} from '../capability-negotiator.js';
import { type ClientCorrelationStore } from './correlation-store.js';
import { type UnwrappedClientEvent } from './event-pipeline.js';
import { type ClientInboundNotificationDispatcher } from './inbound-notification-dispatcher.js';
import { type ServerMetadataStore } from './server-metadata-store.js';

export interface ClientInboundCoordinatorDeps {
  capabilityNegotiator: ClientCapabilityNegotiator;
  correlationStore: ClientCorrelationStore;
  notificationDispatcher: ClientInboundNotificationDispatcher;
  metadataStore: ServerMetadataStore;
  unwrapEvent: (event: NostrEvent) => Promise<UnwrappedClientEvent | null>;
  convertNostrEventToMcpMessage: (event: NostrEvent) => JSONRPCMessage | null;
  handleResponse: (correlatedEventId: string, msg: JSONRPCMessage) => void;
  handleNotification: (
    eventId: string,
    correlatedEventId: string | undefined,
    msg: JSONRPCMessage,
  ) => void;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/**
 * Owns the inbound protocol workflow for the client: discovery learning,
 * initialize tracking, message classification, and response routing.
 */
export class ClientInboundCoordinator {
  constructor(private deps: ClientInboundCoordinatorDeps) {}

  /**
   * Processes an inbound Nostr event by unwrapping, validating, and routing it.
   */
  public async processIncomingEvent(event: NostrEvent): Promise<void> {
    try {
      const unwrapped = await this.deps.unwrapEvent(event);
      if (!unwrapped) {
        return;
      }
      const nostrEvent = unwrapped.event;

      this.learnServerDiscovery(nostrEvent);

      const eTag = getNostrEventTag(nostrEvent.tags, 'e');

      if (!this.deps.metadataStore.getServerInitializeEvent() && eTag) {
        this.trySetInitializeEventFromResponse(nostrEvent);
      }

      const mcpMessage = this.deps.convertNostrEventToMcpMessage(nostrEvent);

      if (!mcpMessage) {
        this.deps.logger.error(
          'Skipping invalid Nostr event with malformed JSON content',
          { eventId: nostrEvent.id, pubkey: nostrEvent.pubkey },
        );
        return;
      }

      // CEP-22/41 Interception
      if (this.deps.notificationDispatcher.tryIntercept(mcpMessage, nostrEvent.id, eTag ?? undefined)) {
        return;
      }

      // Message classification MUST be based on JSON-RPC type, not on the presence of an `e` tag.
      // CEP-8 notifications are correlated (include `e`) but are still notifications.
      if (
        isJSONRPCResultResponse(mcpMessage) ||
        isJSONRPCErrorResponse(mcpMessage)
      ) {
        if (!eTag) {
          this.deps.logger.warn(
            'Received JSON-RPC response without correlation `e` tag',
            {
              eventId: nostrEvent.id,
            },
          );
          return;
        }

        if (!this.deps.correlationStore.hasPendingRequest(eTag)) {
          this.deps.logger.warn('Received response for unknown/expired request', {
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
            this.deps.metadataStore.updateListEnvelopeState('tools', nostrEvent);
          } else if (ListResourcesResultSchema.safeParse(result).success) {
            this.deps.metadataStore.updateListEnvelopeState('resources', nostrEvent);
          } else if (ListResourceTemplatesResultSchema.safeParse(result).success) {
            this.deps.metadataStore.updateListEnvelopeState('templates', nostrEvent);
          } else if (ListPromptsResultSchema.safeParse(result).success) {
            this.deps.metadataStore.updateListEnvelopeState('prompts', nostrEvent);
          }
        }

        this.deps.handleResponse(eTag, mcpMessage);
        return;
      }

      if (isJSONRPCNotification(mcpMessage)) {
        this.deps.handleNotification(nostrEvent.id, eTag ?? undefined, mcpMessage);
        return;
      }

      this.deps.logger.warn('Received unsupported JSON-RPC message type', {
        eventId: nostrEvent.id,
        hasETag: !!eTag,
      });
    } catch (error) {
      this.deps.logger.error('Error handling incoming Nostr event', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
      });
      this.deps.onerror?.(
        error instanceof Error
          ? error
          : new Error('Failed to handle incoming Nostr event'),
      );
    }
  }

  private learnServerDiscovery(event: NostrEvent): void {
    if (!Array.isArray(event.tags)) {
      return;
    }

    const discovered = parseDiscoveredPeerCapabilities(event.tags);
    if (discovered.discoveryTags.length === 0) {
      return;
    }

    this.deps.capabilityNegotiator.learnServerCapabilities(discovered);
    this.deps.metadataStore.setSupportsOversizedTransfer(
      discovered.supportsOversizedTransfer,
    );
    this.deps.metadataStore.setSupportsOpenStream(discovered.supportsOpenStream);

    if (!this.deps.metadataStore.getServerInitializeEvent()) {
      this.setInitializeEvent(event);
      this.deps.logger.info('Learned server discovery tags from inbound event', {
        eventId: event.id,
      });
      return;
    }

    const currentHasInitializeResult = InitializeResultSchema.safeParse(
      this.getInitializeResultCandidate(event),
    ).success;
    const existingHasInitializeResult = InitializeResultSchema.safeParse(
      this.getInitializeResultCandidate(
        this.deps.metadataStore.getServerInitializeEvent(),
      ),
    ).success;

    if (!existingHasInitializeResult && currentHasInitializeResult) {
      this.setInitializeEvent(event);
      this.deps.logger.info(
        'Upgraded learned server discovery event to initialize response',
        {
          eventId: event.id,
        },
      );
    }
  }

  private trySetInitializeEventFromResponse(event: NostrEvent): void {
    try {
      const content = JSON.parse(event.content);
      const parse = InitializeResultSchema.safeParse(content.result);
      if (parse.success) {
        this.setInitializeEvent(event);
        this.deps.logger.info('Received server initialize event', {
          eventId: event.id,
        });
      }
    } catch {
      this.deps.logger.debug('Event is not a valid initialize response', {
        eventId: event.id,
      });
    }
  }

  private setInitializeEvent(event: NostrEvent): void {
    this.deps.metadataStore.setServerInitializeEvent(event);
    this.deps.capabilityNegotiator.setServerInitializeEvent(event);
  }

  private getInitializeResultCandidate(event: NostrEvent | undefined): unknown {
    if (!event) {
      return undefined;
    }

    try {
      const content = JSON.parse(event.content) as { result?: unknown };
      return content.result;
    } catch {
      return undefined;
    }
  }
}
