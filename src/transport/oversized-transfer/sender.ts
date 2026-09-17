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

  const bytes = new TextEncoder().encode(str);
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  let start = 0;
  while (bytes.length - start > maxBytes) {
    let end = start + maxBytes;
    // Back off to a UTF-8 character boundary.
    while (end > start && bytes[end] >= 0x80 && bytes[end] < 0xc0) {
      end--;
    }
    if (end === start) {
      // The window starts mid-character: measure it for the error message.
      let charBytes = 1;
      while (
        start + charBytes < bytes.length &&
        bytes[start + charBytes] >= 0x80 &&
        bytes[start + charBytes] < 0xc0
      ) {
        charBytes++;
      }
      throw new Error(
        `Unable to split message: single character exceeds chunk size (${charBytes} > ${maxBytes})`,
      );
    }
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }

  if (bytes.length > start) {
    chunks.push(decoder.decode(bytes.subarray(start)));
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
