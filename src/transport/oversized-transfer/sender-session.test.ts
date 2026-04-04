import { describe, expect, test } from 'bun:test';
import {
  sendOversizedTransfer,
  type OversizedTransferProgress,
} from './index.js';

describe('sendOversizedTransfer', () => {
  test('publishes start, chunks, and end in order without accept', async () => {
    const published: OversizedTransferProgress[] = [];

    const endEventId = await sendOversizedTransfer('abcdefghij', {
      progressToken: 'token-1',
      chunkSizeBytes: 4,
      needsAcceptHandshake: false,
      publishFrame: async (frame) => {
        published.push(frame);
        return `event-${published.length}`;
      },
    });

    expect(published.map((frame) => frame.cvm.frameType)).toEqual([
      'start',
      'chunk',
      'chunk',
      'chunk',
      'end',
    ]);
    expect(endEventId).toBe('event-5');
  });

  test('waits for accept before publishing chunks when handshake is required', async () => {
    const published: Array<{ frameType: string; isStartFrame: boolean }> = [];
    const order: string[] = [];

    await sendOversizedTransfer('abcdefgh', {
      progressToken: 'token-2',
      chunkSizeBytes: 4,
      needsAcceptHandshake: true,
      publishFrame: async (frame, ctx) => {
        published.push({
          frameType: frame.cvm.frameType,
          isStartFrame: ctx.isStartFrame,
        });
        order.push(`publish:${frame.cvm.frameType}`);
        return undefined;
      },
      waitForAccept: async (progressToken) => {
        order.push(`accept:${progressToken}`);
      },
    });

    expect(order).toEqual([
      'publish:start',
      'accept:token-2',
      'publish:chunk',
      'publish:chunk',
      'publish:end',
    ]);
    expect(published[0]).toEqual({ frameType: 'start', isStartFrame: true });
    expect(published[published.length - 1]).toEqual({
      frameType: 'end',
      isStartFrame: false,
    });
  });
});
