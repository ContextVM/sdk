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
      progress: 2,
      cvm: {
        type: 'open-stream',
        frameType: 'ping',
        nonce: 'token-keepalive:1',
      },
    });
    expect(frames[2]).toMatchObject({
      progressToken: 'token-keepalive',
      progress: 3,
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
    if (frames[1]?.cvm.frameType !== 'close') {
      throw new Error('Expected close frame');
    }
    expect('lastChunkIndex' in frames[1].cvm).toBe(false);
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

  test('runs lifecycle hooks after terminal frames are published', async () => {
    const lifecycle: string[] = [];
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-hooks',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
      onClose: async (): Promise<void> => {
        lifecycle.push('close');
      },
      onAbort: async (reason?: string): Promise<void> => {
        lifecycle.push(`abort:${reason ?? ''}`);
      },
    });

    await writer.close();

    expect(frames[frames.length - 1]).toMatchObject({
      cvm: {
        type: 'open-stream',
        frameType: 'close',
      },
    });
    expect(lifecycle).toEqual(['close']);

    const abortWriter = new OpenStreamWriter({
      progressToken: 'token-hooks-abort',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
      onAbort: async (reason?: string): Promise<void> => {
        lifecycle.push(`abort:${reason ?? ''}`);
      },
    });

    await abortWriter.abort('done');

    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(frames[frames.length - 1]).toMatchObject({
      cvm: {
        type: 'open-stream',
        frameType: 'abort',
        reason: 'done',
      },
    });
    expect(lifecycle).toEqual(['close', 'abort:done']);
  });

  test('abort deactivates and runs local cleanup without waiting for a stuck write', async () => {
    let releaseChunkPublish: (() => void) | undefined;
    const lifecycle: string[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-stuck-abort',
      publishFrame: async (frame): Promise<string | undefined> => {
        if (frame.cvm.frameType === 'chunk') {
          await new Promise<void>((resolve) => {
            releaseChunkPublish = resolve;
          });
        }

        return undefined;
      },
      onAbort: async (reason?: string): Promise<void> => {
        lifecycle.push(`abort:${reason ?? ''}`);
      },
    });

    const writePromise = writer.write('hello');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await writer.abort('stuck publish');

    expect(writer.isActive).toBe(false);
    expect(lifecycle).toEqual(['abort:stuck publish']);

    releaseChunkPublish?.();
    await writePromise;
  });

  test('serializes concurrent writes before close', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-concurrent-writes',
      publishFrame: async (frame): Promise<string | undefined> => {
        await new Promise((resolve) =>
          setTimeout(resolve, frame.cvm.frameType === 'chunk' ? 5 : 0),
        );
        frames.push(frame);
        return undefined;
      },
    });

    await Promise.all([
      writer.write('hello'),
      writer.write('world'),
      writer.close(),
    ]);

    expect(frames).toHaveLength(4);
    expect(frames.map((frame) => frame.cvm.frameType)).toEqual([
      'start',
      'chunk',
      'chunk',
      'close',
    ]);
    expect(frames[1]).toMatchObject({
      progress: 2,
      cvm: {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 0,
        data: 'hello',
      },
    });
    expect(frames[2]).toMatchObject({
      progress: 3,
      cvm: {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 1,
        data: 'world',
      },
    });
    expect(frames[3]).toMatchObject({
      progress: 4,
      cvm: {
        type: 'open-stream',
        frameType: 'close',
        lastChunkIndex: 1,
      },
    });
  });
});
