import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_CHUNK_SIZE, DIGEST_PREFIX } from './constants.js';
import { OversizedTransferProgress } from './types.js';

export interface SenderOptions {
  progressToken: string;
  chunkSizeBytes?: number;

  //Used to track from what offset progress should be monitored as if handshake required, first 2 events are for handshake
  needsAcceptHandshake?: boolean;
}

export interface SenderResult {
  startFrame: OversizedTransferProgress;
  chunkFrames: OversizedTransferProgress[];
  endFrame: OversizedTransferProgress;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function sha256Digest(value: string): string {
  return DIGEST_PREFIX + bytesToHex(sha256(new TextEncoder().encode(value)));
}

// Splits a string into multiple chunks based on byte size.
function splitStringByByteSize(str: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid chunkSizeBytes: ${String(maxBytes)}`);
  }

  const chunks: string[] = [];

  let currentChunk = '';
  let currentChunkBytes = 0;

  for (const char of str) {
    const charBytes = utf8ByteLength(char);
    if (charBytes > maxBytes) {
      throw new Error(
        `Unable to split message: single character exceeds chunk size (${charBytes} > ${maxBytes})`,
      );
    }

    if (currentChunkBytes > 0 && currentChunkBytes + charBytes > maxBytes) {
      chunks.push(currentChunk);
      currentChunk = char;
      currentChunkBytes = charBytes;
      continue;
    }

    currentChunk += char;
    currentChunkBytes += charBytes;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

// Splits serialized into an ordered sequence of oversized-transfer frames ready to be sent as notifications/progress messages.
export async function buildOversizedTransferFrames(
  serialized: string,
  options: SenderOptions,
): Promise<SenderResult> {
  const totalBytes = utf8ByteLength(serialized);
  const digest = sha256Digest(serialized);

  const chunkSize = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE;
  const textChunks = splitStringByByteSize(serialized, chunkSize);
  const totalChunks = textChunks.length;

  // When accept handshake is needed, progress=2 is reserved for the server's
  // accept frame, so chunks begin at 3.
  const chunkBaseProgress = options.needsAcceptHandshake ? 3 : 2;

  const startFrame: OversizedTransferProgress = {
    progressToken: options.progressToken,
    progress: 1,
    message: 'starting oversized transfer',
    cvm: {
      type: 'oversized-transfer',
      frameType: 'start',
      completionMode: 'render',
      digest,
      totalBytes,
      totalChunks,
    },
  };

  const chunkFrames: OversizedTransferProgress[] = textChunks.map(
    (data, i) => ({
      progressToken: options.progressToken,
      progress: chunkBaseProgress + i,
      cvm: {
        type: 'oversized-transfer',
        frameType: 'chunk',
        data,
      },
    }),
  );

  const endFrame: OversizedTransferProgress = {
    progressToken: options.progressToken,
    progress: chunkBaseProgress + totalChunks,
    message: 'oversized transfer complete',
    cvm: {
      type: 'oversized-transfer',
      frameType: 'end',
    },
  };

  return { startFrame, chunkFrames, endFrame };
}
