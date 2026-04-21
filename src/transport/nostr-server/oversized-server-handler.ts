import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { NostrEvent } from 'nostr-tools';
import type { Logger } from '../../core/utils/logger.js';
import { CTXVM_MESSAGES_KIND } from '../../core/constants.js';
import {
  sendOversizedTransfer,
  type OversizedTransferProgress,
} from '../oversized-transfer/index.js';

/**
 * Dependencies required to publish oversized server response frames.
 */
export interface OversizedServerResponseDeps {
  sendMcpMessage: (
    message: JSONRPCMessage,
    recipientPublicKey: string,
    kind: number,
    tags?: NostrEvent['tags'],
    isEncrypted?: boolean,
    onEventCreated?: (eventId: string) => void,
    giftWrapKind?: number,
  ) => Promise<string>;
  logger: Logger;
}

/**
 * Dependencies required to publish a CEP-22 accept frame.
 */
export interface OversizedAcceptFrameDeps {
  sendNotification: (
    clientPubkey: string,
    notification: JSONRPCMessage,
    correlatedEventId?: string,
  ) => Promise<void>;
}

/**
 * Runtime configuration for oversized server frame publication.
 */
export interface OversizedServerHandlerConfig {
  chunkSizeBytes: number;
}

/**
 * Inputs required to publish an oversized server response.
 */
export interface SendOversizedServerResponseOptions {
  serialized: string;
  clientPubkey: string;
  progressToken: string;
  startFrameTags: string[][];
  continuationFrameTags: string[][];
  isEncrypted: boolean;
  giftWrapKind?: number;
}

/**
 * Sends an oversized JSON-RPC response as CEP-22 progress frames.
 */
export async function sendOversizedServerResponse(
  options: SendOversizedServerResponseOptions,
  config: OversizedServerHandlerConfig,
  deps: OversizedServerResponseDeps,
): Promise<void> {
  deps.logger.debug('Sending oversized server response', {
    progressToken: options.progressToken,
    chunkSizeBytes: config.chunkSizeBytes,
  });

  const sendFrame = async (
    params: OversizedTransferProgress,
    tags: string[][],
  ): Promise<void> => {
    const notification: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params,
    };
    await deps.sendMcpMessage(
      notification,
      options.clientPubkey,
      CTXVM_MESSAGES_KIND,
      tags,
      options.isEncrypted,
      undefined,
      options.giftWrapKind,
    );
  };

  await sendOversizedTransfer(options.serialized, {
    progressToken: options.progressToken,
    chunkSizeBytes: config.chunkSizeBytes,
    needsAcceptHandshake: false,
    publishFrame: (frame, ctx) =>
      sendFrame(
        frame,
        ctx.isStartFrame
          ? options.startFrameTags
          : options.continuationFrameTags,
      ).then(() => undefined),
  });
}

/**
 * Inputs required to publish a CEP-22 accept frame.
 */
export interface SendAcceptFrameOptions {
  clientPubkey: string;
  progressToken: string;
}

/**
 * Sends the CEP-22 accept frame for an inbound oversized transfer start.
 */
export async function sendAcceptFrame(
  options: SendAcceptFrameOptions,
  deps: OversizedAcceptFrameDeps,
): Promise<void> {
  const acceptParams: OversizedTransferProgress = {
    progressToken: options.progressToken,
    // progress=2 is the slot reserved between start(1) and the first chunk(3).
    progress: 2,
    message: 'oversized request accepted',
    cvm: {
      type: 'oversized-transfer',
      frameType: 'accept',
    },
  };

  const notification: JSONRPCMessage = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: acceptParams,
  };

  await deps.sendNotification(options.clientPubkey, notification);
}
