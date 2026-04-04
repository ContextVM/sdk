import { describe, expect, test } from 'bun:test';
import {
  buildOversizedTransferFrames,
  sha256Digest,
  utf8ByteLength,
} from './sender.js';

describe('buildOversizedTransferFrames', () => {
  test('splits UTF-8 payloads by byte size without breaking multibyte characters', async () => {
    const serialized = 'á🙂b';

    const frames = await buildOversizedTransferFrames(serialized, {
      progressToken: 'token-utf8',
      chunkSizeBytes: 4,
    });

    const chunkData = frames.chunkFrames.map((frame) => {
      const chunkFrame = frame.cvm;
      if (chunkFrame.frameType !== 'chunk') {
        throw new Error('Expected chunk frame');
      }

      return chunkFrame.data;
    });

    expect(frames.chunkFrames.map((frame) => frame.cvm.frameType)).toEqual([
      'chunk',
      'chunk',
      'chunk',
    ]);
    expect(chunkData).toEqual(['á', '🙂', 'b']);

    const startFrame = frames.startFrame.cvm;
    if (startFrame.frameType !== 'start') {
      throw new Error('Expected start frame');
    }

    expect(startFrame.totalBytes).toBe(utf8ByteLength(serialized));
    expect(startFrame.digest).toBe(sha256Digest(serialized));
  });
});
