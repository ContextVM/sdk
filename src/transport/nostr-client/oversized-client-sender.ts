import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { NostrEvent } from 'nostr-tools';
import type { Logger } from '../../core/utils/logger.js';
import { CTXVM_MESSAGES_KIND } from '../../core/constants.js';
import {
  sendOversizedTransfer,
  type OversizedTransferProgress,
} from '../oversized-transfer/index.js';

/**
 * Dependencies required to publish oversized client frames.
 */
export interface OversizedClientSenderDeps {
  sendMcpMessage: (
    message: JSONRPCMessage,
    recipientPublicKey: string,
    kind: number,
    tags?: NostrEvent['tags'],
    isEncrypted?: boolean,
    onEventCreated?: (eventId: string) => void,
    giftWrapKind?: number,
  ) => Promise<string>;
  waitForAccept: (token: string, timeoutMs: number) => Promise<void>;
  logger: Logger;
}

/**
 * Runtime configuration for oversized client request publication.
 */
export interface OversizedClientSenderConfig {
  chunkSizeBytes: number;
  acceptTimeoutMs: number;
  serverPubkey: string;
  serverSupportsOversizedTransfer: boolean;
  giftWrapKind: number;
  startFrameTags: string[][];
  continuationFrameTags: string[][];
}

/**
 * Sends an oversized JSON-RPC request as CEP-22 progress frames.
 */
export async function sendOversizedClientRequest(
  serializedMessage: string,
  progressToken: string,
  config: OversizedClientSenderConfig,
  deps: OversizedClientSenderDeps,
): Promise<string | undefined> {
  const needsAcceptHandshake = !config.serverSupportsOversizedTransfer;

  deps.logger.debug('Sending oversized client request', {
    progressToken,
    needsAcceptHandshake,
    chunkSizeBytes: config.chunkSizeBytes,
  });

  const sendFrame = async (
    params: OversizedTransferProgress,
    tags: string[][],
  ): Promise<string> => {
    const notification: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params,
    };

    return deps.sendMcpMessage(
      notification,
      config.serverPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      undefined,
      undefined,
      config.giftWrapKind,
    );
  };

  const endFrameEventId = await sendOversizedTransfer(serializedMessage, {
    progressToken,
    chunkSizeBytes: config.chunkSizeBytes,
    needsAcceptHandshake,
    publishFrame: (frame, ctx) =>
      sendFrame(
        frame,
        ctx.isStartFrame ? config.startFrameTags : config.continuationFrameTags,
      ),
    waitForAccept: (token) => deps.waitForAccept(token, config.acceptTimeoutMs),
  });

  return endFrameEventId;
}
