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

// Splits a string into multiple chunks based on byte size
function splitStringByByteSize(str: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let start = 0;

  while (start < str.length) {
    let end = start;
    let byteCount = 0;

    while (end < str.length) {
      const charBytes = encoder.encode(str[end]).byteLength;
      if (byteCount + charBytes > maxBytes) break;
      byteCount += charBytes;
      end++;
    }

    if (end === start) end++;

    chunks.push(str.slice(start, end));
    start = end;
  }

  return chunks;
}

// Splits serialized into an ordered sequence of oversized-transfer frames ready to be sent as notifications/progress messages.
export async function buildOversizedTransferFrames(
  serialized: string,
  options: SenderOptions,
): Promise<SenderResult> {
  const bytes = new TextEncoder().encode(serialized);
  const totalBytes = bytes.byteLength;

  const digest = DIGEST_PREFIX + bytesToHex(sha256(bytes));

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
