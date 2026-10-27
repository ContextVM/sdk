import { canonicalJson } from '../../core/utils/canonical-json.js';
import type { PaymentResultJournal } from '../../payments/payment-delivery.js';
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
import type { ResolveSafeOversizedChunkSizeParams } from '../base-nostr-transport.js';

/**
 * Dependencies for the OutboundResponseRouter.
 */
export interface OutboundResponseRouterDeps {
  closeSignal?: AbortSignal;
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
  resolveSafeOversizedChunkSize: (
    params: ResolveSafeOversizedChunkSizeParams,
  ) => Promise<number>;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/**
 * Routes outbound JSON-RPC responses back to the original client.
 */
export class OutboundResponseRouter {
  private journal?: PaymentResultJournal;

  /** Installs payment publication persistence without changing unpriced routing. */
  public setPaymentResultJournal(journal: PaymentResultJournal): void {
    this.journal = journal;
  }

  private readonly sending = new Map<string, Promise<void>>();

  constructor(private deps: OutboundResponseRouterDeps) {}

  /**
   * Routes a response, handling oversized transfer and stream deferral.
   */
  public async route(
    response: JSONRPCResponse | JSONRPCErrorResponse,
  ): Promise<void> {
    if (this.deps.closeSignal?.aborted) throw new Error('Transport is closed');
    response = structuredClone(response);
    const key = String(response.id);
    const prior = this.sending.get(key) ?? Promise.resolve();
    const work = prior.catch(() => {}).then(() => this.routeInternal(response));
    this.sending.set(key, work);
    try {
      await work;
    } finally {
      if (this.sending.get(key) === work) this.sending.delete(key);
    }
  }

  private async routeInternal(
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
    if (this.journal) {
      const saved = this.deps.correlationStore.peekRouteSnapshot(nostrEventId);
      const route =
        saved?.route ?? this.deps.correlationStore.getEventRoute(nostrEventId);
      const session =
        saved?.session ??
        (route && this.deps.sessionStore.getSession(route.clientPubkey));
      if (saved && route && session)
        await this.journal.retain(nostrEventId, response, {
          route: { ...route },
          session: { ...session },
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        });
    }
    if (
      this.deps.openStreamFactory.deferIfStreamActive(nostrEventId, response)
    ) {
      return;
    }

    const poppedRoute = this.deps.correlationStore.popEventRoute(nostrEventId);
    const snapshot = this.deps.correlationStore.takeRouteSnapshot(nostrEventId);
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
      snapshot?.session ??
      this.deps.sessionStore.getSession(route.clientPubkey) ??
      pendingEviction?.session;

    if (!session) {
      this.deps.onerror?.(
        new Error(`No session found for client: ${route.clientPubkey}`),
      );
      if (snapshot)
        this.deps.correlationStore.restoreRouteSnapshot(nostrEventId, snapshot);
      if (poppedRoute)
        this.deps.correlationStore.registerEventRoute(
          nostrEventId,
          poppedRoute.clientPubkey,
          poppedRoute.originalRequestId,
          poppedRoute.progressToken,
          poppedRoute.wrapKind,
          poppedRoute.requestEvent,
        );
      throw new Error('Response delivery requires a retained client session');
    }

    const sessionBefore = { ...session };
    let publication:
      Awaited<ReturnType<PaymentResultJournal['prepare']>> | undefined;
    let acknowledgedFrames = 0;
    try {
      publication = snapshot
        ? await this.journal?.prepare(nostrEventId, response, {
            route: { ...route },
            session: { ...session },
            expiresAtMs: Number.MAX_SAFE_INTEGER,
          })
        : undefined;
      if (publication && !publication.publish) return;
      acknowledgedFrames = publication?.acknowledgedFrames ?? 0;
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
        : { ...response };

      // Restore the original request ID in the response
      responseToSend.id = route.originalRequestId;

      const continuationFrameTags = this.deps.createResponseTags(
        route.clientPubkey,
        nostrEventId,
      );
      // Build once: discovery/disclosure tags consume session latches.
      const tags = this.deps.buildOutboundTags({
        baseTags: continuationFrameTags,
        session,
      });
      this.maybeAppendPaymentInteractionDisclosure(tags, session);
      const giftWrapKind = this.deps.chooseGiftWrapKind({
        session,
        fallbackWrapKind: route.wrapKind,
      });

      // CEP-22 Oversized Transfer (proactive path for server responses)
      if (
        route.progressToken &&
        (publication?.chunkSizeBytes !== undefined ||
          (this.deps.oversizedConfig.enabled &&
            session.supportsOversizedTransfer))
      ) {
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
            tags,
            session.isEncrypted,
            giftWrapKind,
          );
        } catch {
          publishedEventSize = Number.POSITIVE_INFINITY;
        }

        if (
          publication?.chunkSizeBytes !== undefined ||
          publishedEventSize > this.deps.oversizedConfig.threshold
        ) {
          const chunkSizeBytes =
            publication?.chunkSizeBytes ??
            (await this.deps.resolveSafeOversizedChunkSize({
              desiredChunkSizeBytes: this.deps.oversizedConfig.chunkSize,
              maxPublishedEventBytes: this.deps.oversizedConfig.threshold,
              recipientPublicKey: route.clientPubkey,
              kind: CTXVM_MESSAGES_KIND,
              progressToken: route.progressToken,
              progress: 2,
              tags: continuationFrameTags,
              isEncrypted: session.isEncrypted,
              giftWrapKind,
            }));

          const serialized = canonicalJson(responseToSend);
          await publication?.framePublished(acknowledgedFrames, chunkSizeBytes);
          let frameIndex = 0;
          await sendOversizedServerResponse(
            {
              serialized,
              clientPubkey: route.clientPubkey,
              progressToken: route.progressToken,
              startFrameTags: tags,
              continuationFrameTags,
              isEncrypted: session.isEncrypted,
              giftWrapKind,
            },
            {
              chunkSizeBytes,
            },
            {
              sendMcpMessage: async (...args) => {
                frameIndex++;
                if (frameIndex <= acknowledgedFrames) return '';
                await publication?.framePublished(
                  frameIndex - 1,
                  chunkSizeBytes,
                );
                const sent = await this.deps.sendMcpMessage(...args);
                await publication?.framePublished(frameIndex, chunkSizeBytes);
                return sent;
              },
              logger: this.deps.logger,
            },
          );
          await publication?.complete();
          return;
        }
      }

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

      if (acknowledgedFrames === 0) {
        await publication?.framePublished(0);
        await this.deps.sendMcpMessage(
          responseToSend,
          route.clientPubkey,
          CTXVM_MESSAGES_KIND,
          tags,
          session.isEncrypted,
          undefined,
          giftWrapKind,
        );
      }
      await publication?.framePublished(1);
      await publication?.complete();
    } catch (error) {
      try {
        await publication?.failed();
      } catch {
        /* The retained result remains recoverable after backend failure. */
      }
      if (this.deps.closeSignal?.aborted) throw error;
      // Tags consume session latches, so a failed attempt restores those as well as its route.
      session.hasSentCommonTags = sessionBefore.hasSentCommonTags;
      session.hasDisclosedPaymentInteraction =
        sessionBefore.hasDisclosedPaymentInteraction;
      this.deps.correlationStore.restoreRouteSnapshot(
        nostrEventId,
        snapshot ?? {
          route: { ...route },
          session: { ...sessionBefore },
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        },
      );
      if (poppedRoute)
        this.deps.correlationStore.registerEventRoute(
          nostrEventId,
          route.clientPubkey,
          route.originalRequestId,
          route.progressToken,
          route.wrapKind,
          route.requestEvent,
        );
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
    const retained =
      this.deps.correlationStore.peekRouteSnapshot(requestEventId);
    const snapshot =
      retained?.route.clientPubkey === clientPubkey ? retained : undefined;
    const session =
      snapshot?.session ?? this.deps.sessionStore.getSession(clientPubkey);
    if (!session) {
      this.deps.logger.warn(
        'Cannot route targeted response: no active session found',
        { clientPubkey, requestEventId },
      );
      return;
    }

    const sessionBefore = { ...session };
    try {
      const tags = this.deps.buildOutboundTags({
        baseTags: this.deps.createResponseTags(clientPubkey, requestEventId),
        session,
      });

      this.maybeAppendPaymentInteractionDisclosure(tags, session);

      const route =
        snapshot?.route ??
        this.deps.correlationStore.getEventRoute(requestEventId);

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
    } catch (error) {
      session.hasSentCommonTags = sessionBefore.hasSentCommonTags;
      session.hasDisclosedPaymentInteraction =
        sessionBefore.hasDisclosedPaymentInteraction;
      throw error;
    }
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
