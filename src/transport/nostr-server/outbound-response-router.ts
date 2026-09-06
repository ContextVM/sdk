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

    const poppedRoute = this.deps.correlationStore.popEventRoute(nostrEventId);
    if (poppedRoute) {
      // The live route was used: drop any snapshot so a later duplicate
      // response for this id cannot be delivered from it.
      this.deps.correlationStore.dropRouteSnapshot(nostrEventId);
    }
    // Route miss fallback: a paid request's route may have been popped by
    // duplicate-delivery cleanup or removed with its evicted session while
    // payment settled. The snapshot captured at invoice issuance (CEP-8)
    // carries the routing fields — and the session — needed to deliver the
    // settled result anyway.
    const snapshot = poppedRoute
      ? undefined
      : this.deps.correlationStore.takeRouteSnapshot(nostrEventId);
    const route = poppedRoute ?? snapshot?.route;

    if (!route) {
      this.deps.onerror?.(
        new Error(`No pending request found for response ID: ${response.id}`),
      );
      return;
    }

    if (snapshot) {
      this.deps.logger.info('Delivering response from payment route snapshot', {
        eventId: nostrEventId,
        clientPubkey: route.clientPubkey,
      });
    }

    const pendingEviction =
      this.deps.openStreamFactory.takePendingEviction(nostrEventId);
    const session =
      this.deps.sessionStore.getSession(route.clientPubkey) ??
      snapshot?.session ??
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

    // discovery tags already computed for the oversized-measurement branch, if it
    // ran without fragmenting. buildOutboundTags() consumes the per-session
    // discovery latch as a side effect, so the send path must reuse these rather
    // than rebuild (otherwise the response ships with no discovery tags).
    let oversizedTags: string[][] | undefined;

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
        // CEP-35 discovery tags ride on the start frame (startFrameTags) above.
        // Payment-interaction disclosure is also covered: the server's
        // availability advertisement (extraCommonTags, e.g.
        // ['payment_interaction','explicit_gating']) flows through getCommonTags()
        // into startFrameTags, and its value always equals the effective session
        // mode when both are present — so no separate disclosure call is needed.
        return;
      }

      // Response fit in a single event: reuse the tags already built for
      // measurement instead of rebuilding, which would drop discovery tags.
      oversizedTags = startFrameTags;
    }

    // Send the response back to the original requester
    const tags =
      oversizedTags ??
      this.deps.buildOutboundTags({
        baseTags: this.deps.createResponseTags(
          route.clientPubkey,
          nostrEventId,
        ),
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
      // Restore what the attempt consumed so a retry can deliver. A
      // snapshot-based attempt must get its snapshot back (route + session
      // copy): re-registering only the live route would strand the retry in
      // the no-session branch once the client's session was evicted, dropping
      // the already-paid result.
      if (snapshot) {
        this.deps.correlationStore.restoreRouteSnapshot(nostrEventId, snapshot);
      } else {
        this.deps.correlationStore.registerEventRoute(
          nostrEventId,
          route.clientPubkey,
          route.originalRequestId,
          route.progressToken,
          route.wrapKind,
          route.requestEvent,
        );
      }
      throw error;
    }
  }

  /**
   * Routes a response back to a specifically targeted client and request event.
   * This bypasses the normal correlation lookup, which is useful when
   * middleware needs to reject a request early (e.g. for explicit gating).
   *
   * The gift-wrap kind mirrors the one recorded for the request event, matching
   * the policy `route()` applies, so a targeted response never downgrades an
   * ephemeral-wrapped request to a relay-stored wrap.
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

    const route = this.deps.correlationStore.getEventRoute(requestEventId);

    const giftWrapKind = this.deps.chooseGiftWrapKind({
      session,
      // Non-destructive read: the route must stay registered for the normal
      // response/cleanup lifecycle that runs after this early rejection.
      fallbackWrapKind: route?.wrapKind,
    });

    // Restore the client's original request id before publishing: the inbound
    // coordinator rewrites request ids to the event id for routing, and this
    // early-rejection exit path must not leak that rewrite onto the wire
    // (mirrors route()'s restore; JSON-RPC responses MUST echo the caller's
    // id, and both SDK clients ignore the wire id anyway).
    const responseToSend = route
      ? { ...response, id: route.originalRequestId }
      : response;

    await this.deps.sendMcpMessage(
      responseToSend,
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
