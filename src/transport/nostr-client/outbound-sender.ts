import {
  type JSONRPCMessage,
  isJSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { CTXVM_MESSAGES_KIND, INITIALIZE_METHOD } from '../../core/index.js';
import { type Logger } from '../../core/utils/logger.js';
import {
  type ClientCorrelationStore,
  type OriginalRequestContext,
} from './correlation-store.js';
import { type ClientCapabilityNegotiator } from '../capability-negotiator.js';
import { sendOversizedClientRequest } from './oversized-client-sender.js';

export interface ClientOutboundSenderDeps {
  serverPubkey: string;
  correlationStore: ClientCorrelationStore;
  capabilityNegotiator: ClientCapabilityNegotiator;
  oversizedEnabled: boolean;
  oversizedThreshold: number;
  oversizedChunkSize: number;
  oversizedAcceptTimeoutMs: number;
  serverSupportsOversizedTransfer: () => boolean;
  createRecipientTags: (pubkey: string) => string[][];
  sendMcpMessage: (
    msg: JSONRPCMessage,
    pubkey: string,
    kind: number,
    tags?: string[][],
    isEncrypted?: boolean,
    onEventPublished?: (id: string) => void,
    wrapKind?: number,
  ) => Promise<string>;
  waitForAccept: (token: string, timeoutMs: number) => Promise<void>;
  getOriginalRequestContext: (msg: JSONRPCMessage) => OriginalRequestContext | undefined;
  resolvePendingOpenStream: (progressToken: string) => void;
  logger: Logger;
}

/**
 * Encapsulates outbound client request routing, including CEP-22 oversized handling.
 */
export class ClientOutboundSender {
  constructor(private deps: ClientOutboundSenderDeps) {}

  /**
   * Sends an MCP message to the server, registering correlation when applicable.
   */
  public async sendRequest(message: JSONRPCMessage): Promise<string> {
    const isRequest = isJSONRPCRequest(message);

    // --- CEP-22 Oversized Transfer (proactive path) ---
    if (this.deps.oversizedEnabled && isRequest) {
      const progressToken = message.params?._meta?.progressToken;
      if (progressToken !== undefined) {
        const serialized = JSON.stringify(message);
        const byteLength = new TextEncoder().encode(serialized).byteLength;
        if (byteLength > this.deps.oversizedThreshold) {
          await this.sendOversizedRequest(
            message,
            serialized,
            String(progressToken),
          );
          return 'oversized-transfer';
        }
      }
    }

    const tags = this.deps.capabilityNegotiator.buildOutboundTags({
      baseTags: this.deps.createRecipientTags(this.deps.serverPubkey),
      includeDiscovery: isRequest,
    });

    const giftWrapKind = this.deps.capabilityNegotiator.chooseOutboundGiftWrapKind();

    const eventId = await this.deps.sendMcpMessage(
      message,
      this.deps.serverPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      undefined,
      (eventId) => {
        const progressToken = isRequest
          ? message.params?._meta?.progressToken
          : undefined;
        const originalRequestContext = isRequest
          ? this.deps.getOriginalRequestContext(message)
          : undefined;
        this.deps.correlationStore.registerRequest(eventId, {
          originalRequestId: isRequest ? message.id : null,
          isInitialize: isRequest && message.method === INITIALIZE_METHOD,
          progressToken:
            progressToken !== undefined ? String(progressToken) : undefined,
          originalRequestContext,
        });

        if (
          isRequest &&
          message.method === 'tools/call' &&
          progressToken !== undefined
        ) {
          this.deps.resolvePendingOpenStream(String(progressToken));
        }
      },
      giftWrapKind,
    );

    if (isRequest) {
      this.deps.capabilityNegotiator.markDiscoveryTagsSent();
    }

    return eventId;
  }

  private async sendOversizedRequest(
    originalMessage: Extract<
      JSONRPCMessage,
      { id: string | number; method: string }
    >,
    serialized: string,
    progressToken: string,
  ): Promise<void> {
    const frameRecipientTags = this.deps.createRecipientTags(this.deps.serverPubkey);
    const startFrameTags = this.deps.capabilityNegotiator.buildOutboundTags({
      baseTags: frameRecipientTags,
      includeDiscovery: true,
    });
    const endFrameEventId = await sendOversizedClientRequest(
      serialized,
      progressToken,
      {
        chunkSizeBytes: this.deps.oversizedChunkSize,
        acceptTimeoutMs: this.deps.oversizedAcceptTimeoutMs,
        serverPubkey: this.deps.serverPubkey,
        serverSupportsOversizedTransfer:
          this.deps.serverSupportsOversizedTransfer(),
        giftWrapKind: this.deps.capabilityNegotiator.chooseOutboundGiftWrapKind(),
        startFrameTags,
        continuationFrameTags: frameRecipientTags,
      },
      {
        sendMcpMessage: this.deps.sendMcpMessage,
        waitForAccept: this.deps.waitForAccept,
        logger: this.deps.logger,
      },
    );

    // Register the original request for correlating the final response.
    if (endFrameEventId) {
      this.deps.correlationStore.registerRequest(endFrameEventId, {
        originalRequestId: originalMessage.id,
        isInitialize: originalMessage.method === INITIALIZE_METHOD,
        progressToken,
        originalRequestContext: this.deps.getOriginalRequestContext(originalMessage),
      });
    }

    this.deps.capabilityNegotiator.markDiscoveryTagsSent();
  }
}
