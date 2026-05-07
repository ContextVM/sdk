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
} from '@modelcontextprotocol/sdk/types.js';
import { type Logger } from '../../core/utils/logger.js';
import { type CorrelationStore } from './correlation-store.js';
import { type ClientSession, type SessionStore } from './session-store.js';
import { type AnnouncementManager } from './announcement-manager.js';
import { type OpenStreamWriter } from '../open-stream/index.js';
import { CTXVM_MESSAGES_KIND } from '../../core/constants.js';
import { sendOversizedServerResponse } from './oversized-server-handler.js';

export interface OutboundResponseRouterDeps {
  correlationStore: CorrelationStore;
  sessionStore: SessionStore;
  announcementManager: AnnouncementManager;
  openStreamWriters: Map<string, OpenStreamWriter>;
  pendingOpenStreamResponses: Map<string, JSONRPCResponse>;
  oversizedConfig: { enabled: boolean; threshold: number; chunkSize: number };
  applyListToolsResultTransformers: (result: ListToolsResult) => ListToolsResult;
  buildOutboundTags: (params: { baseTags: readonly string[][]; session: ClientSession }) => string[][];
  createResponseTags: (clientPubkey: string, eventId: string) => string[][];
  chooseGiftWrapKind: (params: { session: ClientSession; fallbackWrapKind?: number }) => number | undefined;
  sendMcpMessage: (
    message: JSONRPCMessage,
    targetPubkey: string,
    kind: number,
    tags?: string[][],
    encrypt?: boolean,
    onCreateEvent?: (eventId: string) => void,
    giftWrapKind?: number,
  ) => Promise<string>;
  logger: Logger;
  onerror?: (error: Error) => void;
}

export class OutboundResponseRouter {
  constructor(private deps: OutboundResponseRouterDeps) {}

  public async route(
    response: JSONRPCResponse | JSONRPCErrorResponse,
  ): Promise<void> {
    // Handle special announcement responses
    if (response.id === 'announcement') {
      const wasHandled =
        await this.deps.announcementManager.handleAnnouncementResponse(response);
      if (wasHandled && isJSONRPCResultResponse(response)) {
        if (InitializeResultSchema.safeParse(response.result).success) {
          this.deps.logger.info('Initialized');
        }
      }
      return;
    }

    // Find the event route using O(1) lookup
    const nostrEventId = response.id as string;
    const existingOpenStreamWriter = this.deps.openStreamWriters.get(nostrEventId);
    if (existingOpenStreamWriter && existingOpenStreamWriter.isActive) {
      this.deps.pendingOpenStreamResponses.set(nostrEventId, response);
      return;
    }

    const route = this.deps.correlationStore.popEventRoute(nostrEventId);

    if (!route) {
      this.deps.onerror?.(
        new Error(`No pending request found for response ID: ${response.id}`),
      );
      return;
    }

    const session = this.deps.sessionStore.getSession(route.clientPubkey);
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
      // Serialize after restoring the original request id so oversized transfer uses the correct id.
      const serialized = JSON.stringify(responseToSend);
      const byteLength = new TextEncoder().encode(serialized).byteLength;
      if (byteLength > this.deps.oversizedConfig.threshold) {
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
            chunkSizeBytes: this.deps.oversizedConfig.chunkSize,
          },
          {
            sendMcpMessage: this.deps.sendMcpMessage,
            logger: this.deps.logger,
          },
        );
        return;
      }
    }

    // Send the response back to the original requester
    const tags = this.deps.buildOutboundTags({
      baseTags: this.deps.createResponseTags(route.clientPubkey, nostrEventId),
      session,
    });

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
}
