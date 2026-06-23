import {
  type JSONRPCResponse,
  type JSONRPCErrorResponse,
  isJSONRPCResultResponse,
  InitializeResultSchema,
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListPromptsResultSchema,
  type ListToolsResult,
  type JSONRPCMessage,
} from '@contextvm/mcp-sdk/types.js';
import { type Logger } from '../../core/utils/logger.js';
import { type CorrelationStore } from './correlation-store.js';
import { type ClientSession, type SessionStore } from './session-store.js';
import { type AnnouncementManager } from './announcement-manager.js';
import { NOSTR_TAGS, CTXVM_MESSAGES_KIND } from '../../core/constants.js';
import { sendOversizedServerResponse } from './oversized-server-handler.js';

/**
 * Dependencies for the OutboundResponseRouter.
 */
export interface OutboundResponseRouterDeps {
  correlationStore: CorrelationStore;
  sessionStore: SessionStore;
  announcementManager: AnnouncementManager;
  openStreamFactory: {
    deferIfStreamActive: (
      eventId: string,
      response: JSONRPCResponse,
    ) => boolean;
    takePendingEviction: (
      eventId: string,
    ) => { clientPubkey: string; session: ClientSession } | undefined;
  };
  oversizedConfig: { enabled: boolean; threshold: number; chunkSize: number };
  applyListToolsResultTransformers: (
    result: ListToolsResult,
  ) => ListToolsResult;
  buildOutboundTags: (params: {
    baseTags: readonly string[][];
    session: ClientSession;
  }) => string[][];
  createResponseTags: (clientPubkey: string, eventId: string) => string[][];
  chooseGiftWrapKind: (params: {
    session: ClientSession;
    fallbackWrapKind?: number;
  }) => number | undefined;
  sendMcpMessage: (
    message: JSONRPCMessage,
    targetPubkey: string,
    kind: number,
    tags?: string[][],
    encrypt?: boolean,
    onCreateEvent?: (eventId: string) => void,
    giftWrapKind?: number,
  ) => Promise<string>;
  measurePublishedMcpMessageSize: (
    message: JSONRPCMessage,
    recipientPublicKey: string,
    kind: number,
    tags?: string[][],
    isEncrypted?: boolean,
    giftWrapKind?: number,
  ) => Promise<number>;
  resolveSafeOversizedChunkSize: (params: {
    desiredChunkSizeBytes: number;
    maxPublishedEventBytes: number;
    recipientPublicKey: string;
    kind: number;
    progressToken: string;
    progress: number;
    tags?: string[][];
    isEncrypted?: boolean;
    giftWrapKind?: number;
  }) => Promise<number>;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/**
 * Routes outbound JSON-RPC responses back to the original client.
 */
export class OutboundResponseRouter {
  constructor(private deps: OutboundResponseRouterDeps) {}

  /**
   * Routes a response, handling oversized transfer and stream deferral.
   */
  public async route(
    response: JSONRPCResponse | JSONRPCErrorResponse,
  ): Promise<void> {
    // Handle special announcement responses
    if (response.id === 'announcement') {
      const wasHandled =
        await this.deps.announcementManager.handleAnnouncementResponse(
          response,
        );
      if (wasHandled && isJSONRPCResultResponse(response)) {
        if (InitializeResultSchema.safeParse(response.result).success) {
          this.deps.logger.info('Initialized');
        }
      }
      return;
    }

    // Find the event route using O(1) lookup
    const nostrEventId = response.id as string;
    if (
      this.deps.openStreamFactory.deferIfStreamActive(nostrEventId, response)
    ) {
      return;
    }

    const route = this.deps.correlationStore.popEventRoute(nostrEventId);

    if (!route) {
      this.deps.onerror?.(
        new Error(`No pending request found for response ID: ${response.id}`),
      );
      return;
    }

    const pendingEviction =
      this.deps.openStreamFactory.takePendingEviction(nostrEventId);
    const session =
      this.deps.sessionStore.getSession(route.clientPubkey) ??
      pendingEviction?.session;

    if (!session) {
      this.deps.onerror?.(
        new Error(`No session found for client: ${route.clientPubkey}`),
      );
      return;
    }

    const parsedListToolsResult = isJSONRPCResultResponse(response)
      ? ListToolsResultSchema.safeParse(response.result)
      : null;

    const responseToSend = parsedListToolsResult?.success
      ? {
          ...response,
          result: this.deps.applyListToolsResultTransformers(
            parsedListToolsResult.data,
          ),
        }
      : response;

    // Restore the original request ID in the response
    responseToSend.id = route.originalRequestId;

    // CEP-22 Oversized Transfer (proactive path for server responses)
    if (
      this.deps.oversizedConfig.enabled &&
      route.progressToken &&
      session.supportsOversizedTransfer
    ) {
      const continuationFrameTags = this.deps.createResponseTags(
        route.clientPubkey,
        nostrEventId,
      );
      const startFrameTags = this.deps.buildOutboundTags({
        baseTags: continuationFrameTags,
        session,
      });
      const giftWrapKind = this.deps.chooseGiftWrapKind({
        session,
        fallbackWrapKind: route.wrapKind,
      });

      // Measuring the full response can throw under gift-wrap encryption when
      // the inner plaintext exceeds NIP-44's 65 535-byte cap. That is itself
      // proof the response cannot be published as a single encrypted event, so
      // treat the throw as "must fragment".
      let publishedEventSize: number;
      try {
        publishedEventSize = await this.deps.measurePublishedMcpMessageSize(
          responseToSend,
          route.clientPubkey,
          CTXVM_MESSAGES_KIND,
          startFrameTags,
          session.isEncrypted,
          giftWrapKind,
        );
      } catch {
        publishedEventSize = Number.POSITIVE_INFINITY;
      }

      if (publishedEventSize > this.deps.oversizedConfig.threshold) {
        const chunkSizeBytes = await this.deps.resolveSafeOversizedChunkSize({
          desiredChunkSizeBytes: this.deps.oversizedConfig.chunkSize,
          maxPublishedEventBytes: this.deps.oversizedConfig.threshold,
          recipientPublicKey: route.clientPubkey,
          kind: CTXVM_MESSAGES_KIND,
          progressToken: route.progressToken,
          progress: 2,
          tags: continuationFrameTags,
          isEncrypted: session.isEncrypted,
          giftWrapKind,
        });

        const serialized = JSON.stringify(responseToSend);
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
            chunkSizeBytes,
          },
          {
            sendMcpMessage: this.deps.sendMcpMessage,
            logger: this.deps.logger,
          },
        );
        // Note: Oversized transfers skip maybeAppendPaymentInteractionDisclosure() and marking discovery
        // tags as sent on this early return path. This is low risk in practice because oversized transfers
        // only trigger for large payloads, and negotiation usually happens early with small messages.
        return;
      }
    }

    // Send the response back to the original requester
    const tags = this.deps.buildOutboundTags({
      baseTags: this.deps.createResponseTags(route.clientPubkey, nostrEventId),
      session,
    });

    this.maybeAppendPaymentInteractionDisclosure(tags, session);

    const giftWrapKind = this.deps.chooseGiftWrapKind({
      session,
      fallbackWrapKind: route.wrapKind,
    });

    // Attach pricing tags to capability list responses so clients can access CEP-8 pricing
    if (isJSONRPCResultResponse(responseToSend)) {
      const result = responseToSend.result;
      if (
        ListToolsResultSchema.safeParse(result).success ||
        ListResourcesResultSchema.safeParse(result).success ||
        ListResourceTemplatesResultSchema.safeParse(result).success ||
        ListPromptsResultSchema.safeParse(result).success
      ) {
        tags.push(...this.deps.announcementManager.getPricingTags());
      }
    }

    try {
      await this.deps.sendMcpMessage(
        responseToSend,
        route.clientPubkey,
        CTXVM_MESSAGES_KIND,
        tags,
        session.isEncrypted,
        undefined,
        giftWrapKind,
      );
    } catch (error) {
      this.deps.correlationStore.registerEventRoute(
        nostrEventId,
        route.clientPubkey,
        route.originalRequestId,
        route.progressToken,
        route.wrapKind,
      );
      throw error;
    }
  }

  /**
   * Routes a response back to a specifically targeted client and request event.
   * This bypasses the normal correlation lookup, which is useful when
   * middleware needs to reject a request early (e.g. for explicit gating).
   */
  public async routeTargeted(
    clientPubkey: string,
    response: JSONRPCResponse | JSONRPCErrorResponse,
    requestEventId: string,
  ): Promise<void> {
    const session = this.deps.sessionStore.getSession(clientPubkey);
    if (!session) {
      this.deps.logger.warn(
        'Cannot route targeted response: no active session found',
        { clientPubkey, requestEventId },
      );
      return;
    }

    const tags = this.deps.buildOutboundTags({
      baseTags: this.deps.createResponseTags(clientPubkey, requestEventId),
      session,
    });

    this.maybeAppendPaymentInteractionDisclosure(tags, session);

    const giftWrapKind = this.deps.chooseGiftWrapKind({
      session,
    });

    await this.deps.sendMcpMessage(
      response,
      clientPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      session.isEncrypted,
      undefined,
      giftWrapKind,
    );
  }

  private maybeAppendPaymentInteractionDisclosure(
    tags: string[][],
    session: ClientSession,
  ): void {
    // CEP-8: Disclose effective mode on first response if client requested a non-default mode.
    if (
      session.requestedPaymentInteraction &&
      session.requestedPaymentInteraction !== 'transparent' &&
      !session.hasDisclosedPaymentInteraction &&
      session.effectivePaymentInteraction
    ) {
      const effective = session.effectivePaymentInteraction;
      // The availability advertisement (extraCommonTags) may already be flushed
      // onto this first response with the same value. Avoid emitting a duplicate
      // tag; the existing one already satisfies the disclosure obligation.
      const alreadyPresent = tags.some(
        (t) => t[0] === NOSTR_TAGS.PAYMENT_INTERACTION && t[1] === effective,
      );
      if (!alreadyPresent) {
        tags.push([NOSTR_TAGS.PAYMENT_INTERACTION, effective]);
      }
      session.hasDisclosedPaymentInteraction = true;
    }
  }
}
