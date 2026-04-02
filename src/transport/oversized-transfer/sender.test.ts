import { describe, expect, test } from 'bun:test';
import {
  buildOversizedTransferFrames,
  sha256Digest,
  utf8ByteLength,
} from './sender.js';

describe('buildOversizedTransferFrames', () => {
  test('builds deterministic start/chunk/end frame sequence', () => {
    const serialized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { value: 'ok' },
    });

    const { startFrame, chunkFrames, endFrame } = buildOversizedTransferFrames(
      serialized,
      {
        progressToken: 'token-1',
        chunkSizeBytes: 8,
      },
    );

    expect(startFrame.progress).toBe(1);
    expect(startFrame.cvm.frameType).toBe('start');
    if (startFrame.cvm.frameType !== 'start') {
      throw new Error('expected start frame');
    }

    expect(startFrame.cvm.digest).toBe(sha256Digest(serialized));
    expect(startFrame.cvm.totalBytes).toBe(utf8ByteLength(serialized));
    expect(startFrame.cvm.totalChunks).toBe(chunkFrames.length);

    expect(chunkFrames[0]?.progress).toBe(2);
    expect(endFrame.progress).toBe(chunkFrames.length + 2);

    const reconstructed = chunkFrames
      .map((frame) => {
        if (frame.cvm.frameType !== 'chunk') {
          throw new Error('expected chunk frame');
        }
        return frame.cvm.data;
      })
      .join('');
    expect(reconstructed).toBe(serialized);
  });

  test('reserves progress value 2 when accept handshake is required', () => {
    const serialized = JSON.stringify({
      jsonrpc: '2.0',
      id: 'r1',
      method: 'tools/call',
      params: { name: 'x' },
    });

    const { chunkFrames, endFrame } = buildOversizedTransferFrames(serialized, {
      progressToken: 'token-2',
      chunkSizeBytes: 16,
      needsAcceptHandshake: true,
    });

    expect(chunkFrames[0]?.progress).toBe(3);
    expect(endFrame.progress).toBe(chunkFrames.length + 3);
  });

  test('preserves multi-byte UTF-8 characters in chunking', () => {
    const serialized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        text: 'A\u{1F600}B',
      },
    });

    const { chunkFrames } = buildOversizedTransferFrames(serialized, {
      progressToken: 'token-3',
      chunkSizeBytes: 7,
    });

    const reconstructed = chunkFrames
      .map((frame) => {
        if (frame.cvm.frameType !== 'chunk') {
          throw new Error('expected chunk frame');
        }
        return frame.cvm.data;
      })
      .join('');
    expect(reconstructed).toBe(serialized);
  });

  test('throws when chunk size is invalid', () => {
    expect(() =>
      buildOversizedTransferFrames('{"jsonrpc":"2.0"}', {
        progressToken: 'token-4',
        chunkSizeBytes: 0,
      }),
    ).toThrow('Invalid chunkSizeBytes');
  });
});
