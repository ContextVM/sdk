import { createHash } from 'node:crypto';
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  DIGEST_PREFIX,
  OVERSIZED_TRANSFER_TYPE,
} from './constants.js';
import type { OversizedTransferProgressParams } from './types.js';

export interface OversizedSenderOptions {
  progressToken: string;
  chunkSizeBytes?: number;
  /**
   * When true, reserves progress value 2 for receiver `accept` and starts
   * chunks at progress value 3.
   */
  needsAcceptHandshake?: boolean;
}

export interface OversizedFrameBundle {
  startFrame: OversizedTransferProgressParams;
  chunkFrames: OversizedTransferProgressParams[];
  endFrame: OversizedTransferProgressParams;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function sha256Digest(value: string): string {
  return `${DIGEST_PREFIX}${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function splitStringByUtf8ByteSize(value: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid chunkSizeBytes: ${maxBytes}`);
  }

  const chunks: string[] = [];
  let currentChars: string[] = [];
  let currentBytes = 0;

  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (charBytes > maxBytes) {
      throw new Error(
        `Unable to split message: single character exceeds chunk size (${charBytes} > ${maxBytes})`,
      );
    }

    if (currentBytes > 0 && currentBytes + charBytes > maxBytes) {
      chunks.push(currentChars.join(''));
      currentChars = [char];
      currentBytes = charBytes;
      continue;
    }

    currentChars.push(char);
    currentBytes += charBytes;
  }

  if (currentChars.length > 0) {
    chunks.push(currentChars.join(''));
  }

  return chunks;
}

/**
 * Build an ordered oversized-transfer frame bundle for one serialized message.
 */
export function buildOversizedTransferFrames(
  serializedMessage: string,
  options: OversizedSenderOptions,
): OversizedFrameBundle {
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const chunkPayloads = splitStringByUtf8ByteSize(serializedMessage, chunkSizeBytes);

  const totalBytes = utf8ByteLength(serializedMessage);
  const totalChunks = chunkPayloads.length;
  const chunkStartProgress = options.needsAcceptHandshake ? 3 : 2;

  const startFrame: OversizedTransferProgressParams = {
    progressToken: options.progressToken,
    progress: 1,
    message: 'starting oversized transfer',
    cvm: {
      type: OVERSIZED_TRANSFER_TYPE,
      frameType: 'start',
      completionMode: 'render',
      digest: sha256Digest(serializedMessage),
      totalBytes,
      totalChunks,
    },
  };

  const chunkFrames: OversizedTransferProgressParams[] = chunkPayloads.map(
    (chunkData, index) => ({
      progressToken: options.progressToken,
      progress: chunkStartProgress + index,
      cvm: {
        type: OVERSIZED_TRANSFER_TYPE,
        frameType: 'chunk',
        data: chunkData,
      },
    }),
  );

  const endFrame: OversizedTransferProgressParams = {
    progressToken: options.progressToken,
    progress: chunkStartProgress + totalChunks,
    message: 'oversized transfer complete',
    cvm: {
      type: OVERSIZED_TRANSFER_TYPE,
      frameType: 'end',
    },
  };

  return {
    startFrame,
    chunkFrames,
    endFrame,
  };
}
