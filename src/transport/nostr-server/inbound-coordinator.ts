import {
  type JSONRPCMessage,
  type JSONRPCRequest,
  type JSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { type NostrEvent } from 'nostr-tools';
import { type Logger } from '../../core/utils/logger.js';
import { type SessionStore, type ClientSession } from './session-store.js';
import { type CorrelationStore } from './correlation-store.js';
import { type AuthorizationPolicy } from './authorization-policy.js';
import { type ServerOpenStreamFactory } from './open-stream-factory.js';
import { type InboundNotificationDispatcher } from './inbound-notification-dispatcher.js';
import { type InboundMiddlewareFn } from '../middleware.js';
import {
  injectClientPubkey,
  injectRequestEventId,
} from '../../core/utils/utils.js';
import { learnPeerCapabilities } from '../capability-negotiator.js';
import {
  CTXVM_MESSAGES_KIND,
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
  NOTIFICATIONS_INITIALIZED_METHOD,
} from '../../core/index.js';
import { GiftWrapMode } from '../../core/interfaces.js';
import { type OpenStreamWriter } from '../open-stream/index.js';

export interface ServerInboundCoordinatorDeps {
  sessionStore: SessionStore;
  correlationStore: CorrelationStore;
  authorizationPolicy: AuthorizationPolicy;
  openStreamFactory: ServerOpenStreamFactory;
  inboundMiddlewares: InboundMiddlewareFn[];
  injectClientPubkey: boolean;
  shouldInjectRequestEventId: boolean;
  oversizedEnabled: boolean;
  openStreamEnabled: boolean;
  giftWrapMode: GiftWrapMode;
  sendMcpMessage: (
    msg: JSONRPCMessage,
    pubkey: string,
    kind: number,
    tags: string[][],
    isEncrypted: boolean,
    onEventPublished?: (id: string) => void,
    wrapKind?: number,
  ) => Promise<string>;
  createResponseTags: (clientPubkey: string, requestId: string) => string[][];
  getOrCreateClientSession: (clientPubkey: string, isEncrypted: boolean) => ClientSession;
  forwardMessage: (msg: JSONRPCMessage, clientPubkey: string) => Promise<boolean>;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/**
 * Owns the inbound protocol workflow for the server: parsing, capability learning,
 * authorization gating, request decoration, and middleware dispatch.
 */
export class ServerInboundCoordinator {
  private inboundNotificationDispatcher?: InboundNotificationDispatcher;

  constructor(private deps: ServerInboundCoordinatorDeps) {}

  public setNotificationDispatcher(dispatcher: InboundNotificationDispatcher): void {
    this.inboundNotificationDispatcher = dispatcher;
  }

  /**
   * Authorizes and processes an incoming Nostr event, handling message validation,
   * client authorization, session management, and optional client public key injection.
   */
  public async authorizeAndProcessEvent(
    event: NostrEvent,
    isEncrypted: boolean,
    mcpMessage: JSONRPCMessage,
    wrapKind?: number,
  ): Promise<void> {
    try {
      const inboundMessage: JSONRPCMessage = mcpMessage;

      const authDecision = await this.deps.authorizationPolicy.authorize(
        event.pubkey,
        mcpMessage,
      );

      if (!authDecision.allowed) {
        this.deps.logger.error(
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

          const tags = this.deps.createResponseTags(event.pubkey, event.id);
          this.deps
            .sendMcpMessage(
              errorResponse,
              event.pubkey,
              CTXVM_MESSAGES_KIND,
              tags,
              isEncrypted,
              undefined,
              isEncrypted
                ? this.deps.giftWrapMode === GiftWrapMode.EPHEMERAL
                  ? EPHEMERAL_GIFT_WRAP_KIND
                  : this.deps.giftWrapMode === GiftWrapMode.PERSISTENT
                    ? GIFT_WRAP_KIND
                    : wrapKind
                : undefined,
            )
            .catch((err) => {
              this.deps.logger.error('Failed to send unauthorized response', {
                error: err instanceof Error ? err.message : String(err),
                pubkey: event.pubkey,
                eventId: event.id,
              });
              this.deps.onerror?.(
                new Error(`Failed to send unauthorized response: ${err}`),
              );
            });
        }
        return;
      }

      const session = this.deps.getOrCreateClientSession(event.pubkey, isEncrypted);
      const hadLearnedOversizedSupport = session.supportsOversizedTransfer;
      const discoveredCapabilities = learnPeerCapabilities(event.tags);
      session.supportsEncryption ||= discoveredCapabilities.supportsEncryption;
      session.supportsEphemeralEncryption ||=
        discoveredCapabilities.supportsEphemeralEncryption;
      session.supportsOversizedTransfer ||=
        this.deps.oversizedEnabled &&
        discoveredCapabilities.supportsOversizedTransfer;
      session.supportsOpenStream ||=
        this.deps.openStreamEnabled && discoveredCapabilities.supportsOpenStream;

      const shouldSendAccept = !hadLearnedOversizedSupport;

      const clientPmis = event.tags
        .filter((tag) => tag[0] === 'pmi' && typeof tag[1] === 'string')
        .map((tag) => tag[1] as string);
      const ctx = {
        clientPubkey: event.pubkey,
        clientPmis: clientPmis.length > 0 ? clientPmis : undefined,
      };
      const middlewares = this.deps.inboundMiddlewares;

      const dispatch = async (
        index: number,
        msg: JSONRPCMessage,
      ): Promise<boolean> => {
        const mw = middlewares[index];
        if (!mw) {
          return await this.deps.forwardMessage(msg, event.pubkey);
        }
        let forwarded = false;
        await mw(msg, ctx, async (nextMsg) => {
          forwarded = await dispatch(index + 1, nextMsg);
        });
        return forwarded;
      };

      if (isJSONRPCRequest(inboundMessage)) {
        this.handleIncomingRequest(
          event,
          event.id,
          inboundMessage,
          event.pubkey,
          wrapKind,
        );

        if (this.deps.shouldInjectRequestEventId) {
          injectRequestEventId(inboundMessage, event.id);
        }

        if (this.deps.injectClientPubkey) {
          injectClientPubkey(inboundMessage, event.pubkey);
        }

        const openStreamWriter = this.deps.openStreamFactory.getWriter(event.id);
        if (openStreamWriter) {
          const params = inboundMessage.params ?? {};
          inboundMessage.params = params;
          const meta = params._meta ?? {};
          params._meta = meta;
          (meta as { stream?: OpenStreamWriter }).stream = openStreamWriter;
        }
      } else if (isJSONRPCNotification(inboundMessage)) {
        this.handleIncomingNotification(event.pubkey, inboundMessage);

        const intercepted = this.inboundNotificationDispatcher?.tryIntercept(
          inboundMessage,
          { event, session, shouldSendAccept, wrapKind },
          (msg) => dispatch(0, msg),
        );
        if (intercepted) return;
      }

      void dispatch(0, inboundMessage)
        .then((forwarded) => {
          if (!forwarded) {
            this.cleanupDroppedRequest(inboundMessage);
          }
        })
        .catch((err: unknown) => {
          this.deps.logger.error('Error in inboundMiddleware chain', {
            error: err instanceof Error ? err.message : String(err),
            eventId: event.id,
            pubkey: event.pubkey,
          });
          this.deps.onerror?.(
            err instanceof Error ? err : new Error('inboundMiddleware failed'),
          );
        });
    } catch (error) {
      this.deps.logger.error('Error in authorizeAndProcessEvent', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        eventId: event.id,
        pubkey: event.pubkey,
      });
      this.deps.onerror?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Handles incoming requests with correlation tracking.
   */
  public handleIncomingRequest(
    event: NostrEvent,
    eventId: string,
    request: JSONRPCRequest,
    clientPubkey: string,
    wrapKind?: number,
  ): void {
    const originalRequestId = request.id;
    request.id = eventId;

    const progressToken = request.params?._meta?.progressToken;
    this.deps.correlationStore.registerEventRoute(
      eventId,
      clientPubkey,
      originalRequestId,
      progressToken ? String(progressToken) : undefined,
      wrapKind,
      this.deps.shouldInjectRequestEventId ? event : undefined,
    );

    this.deps.openStreamFactory.createWriterIfEnabled(
      eventId,
      clientPubkey,
      progressToken ? String(progressToken) : undefined,
    );
  }

  /**
   * Cleans up request correlation for a request that was dropped by middleware.
   */
  public cleanupDroppedRequest(message: JSONRPCMessage): void {
    if (!isJSONRPCRequest(message)) {
      return;
    }
    this.deps.correlationStore.popEventRoute(String(message.id));
  }

  /**
   * Handles incoming notifications.
   */
  public handleIncomingNotification(
    clientPubkey: string,
    notification: JSONRPCMessage,
  ): void {
    if (
      isJSONRPCNotification(notification) &&
      notification.method === NOTIFICATIONS_INITIALIZED_METHOD
    ) {
      this.deps.sessionStore.markInitialized(clientPubkey);
    }
  }
}
