import { describe, expect, test } from 'bun:test';
import type { OpenStreamProgress } from './types.js';
import { OpenStreamWriter } from './writer.js';

describe('OpenStreamWriter', () => {
  test('emits ping and pong frames with matching nonce values', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-keepalive',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
    });

    await writer.start();
    await writer.ping();
    await writer.pong('keepalive-nonce');

    expect(frames).toHaveLength(3);
    expect(frames[1]).toMatchObject({
      progressToken: 'token-keepalive',
      progress: 3,
      cvm: {
        type: 'open-stream',
        frameType: 'ping',
        nonce: '2',
      },
    });
    expect(frames[2]).toMatchObject({
      progressToken: 'token-keepalive',
      progress: 4,
      cvm: {
        type: 'open-stream',
        frameType: 'pong',
        nonce: 'keepalive-nonce',
      },
    });
  });

  test('omits lastChunkIndex on close when no chunks were written', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-empty-close',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
    });

    await writer.close();

    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({
      cvm: {
        type: 'open-stream',
        frameType: 'close',
      },
    });
    expect('lastChunkIndex' in frames[1]!.cvm).toBe(true);
    if (frames[1]?.cvm.frameType !== 'close') {
      throw new Error('Expected close frame');
    }
    expect(frames[1].cvm.lastChunkIndex).toBeUndefined();
  });

  test('includes lastChunkIndex on close after chunk writes', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-chunk-close',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
    });

    await writer.write('hello');
    await writer.write('world');
    await writer.close();

    expect(frames).toHaveLength(4);
    expect(frames[3]).toMatchObject({
      cvm: {
        type: 'open-stream',
        frameType: 'close',
        lastChunkIndex: 1,
      },
    });
  });
});
