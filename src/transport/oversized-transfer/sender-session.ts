import { buildOversizedTransferFrames, type SenderOptions } from './sender.js';
import type { OversizedTransferProgress } from './types.js';

export interface OversizedFramePublishContext {
  isStartFrame: boolean;
}

export type OversizedFramePublisher = (
  frame: OversizedTransferProgress,
  ctx: OversizedFramePublishContext,
) => Promise<string | void>;

export type OversizedAcceptWaiter = (progressToken: string) => Promise<void>;

export interface OversizedSendOptions extends SenderOptions {
  publishFrame: OversizedFramePublisher;
  waitForAccept?: OversizedAcceptWaiter;
}

/**
 * Builds and publishes a full CEP-XX oversized transfer sequence.
 */
export async function sendOversizedTransfer(
  serialized: string,
  options: OversizedSendOptions,
): Promise<string | undefined> {
  const { startFrame, chunkFrames, endFrame } =
    await buildOversizedTransferFrames(serialized, options);

  await options.publishFrame(startFrame, {
    isStartFrame: true,
  });

  if (options.needsAcceptHandshake) {
    await options.waitForAccept?.(options.progressToken);
  }

  for (const chunk of chunkFrames) {
    await options.publishFrame(chunk, { isStartFrame: false });
  }

  const endEventId = await options.publishFrame(endFrame, {
    isStartFrame: false,
  });
  return typeof endEventId === 'string' ? endEventId : undefined;
}
