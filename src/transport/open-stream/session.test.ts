import { describe, expect, test } from 'bun:test';
import { OpenStreamAbortError, OpenStreamSequenceError } from './errors.js';
import { OpenStreamSession } from './session.js';

describe('OpenStreamSession', () => {
  test('yields ordered chunks and finishes after close', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-1',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 0,
      data: 'hello',
    });
    await session.processFrame(3, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 1,
      data: ' world',
    });
    await session.processFrame(4, {
      type: 'open-stream',
      frameType: 'close',
    });

    const chunks: string[] = [];
    for await (const chunk of session) {
      chunks.push(chunk.value);
    }

    expect(chunks).toEqual(['hello', ' world']);
    await expect(session.closed).resolves.toBeUndefined();
  });

  test('buffers out-of-order chunks until contiguous', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-2',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 1,
      data: 'world',
    });
    await session.processFrame(3, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 0,
      data: 'hello ',
    });
    await session.processFrame(4, {
      type: 'open-stream',
      frameType: 'close',
    });

    const received: string[] = [];
    for await (const chunk of session) {
      received.push(chunk.value);
    }

    expect(received).toEqual(['hello ', 'world']);
  });

  test('fails when progress does not increase', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-3',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await expect(
      session.processFrame(1, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 0,
        data: 'repeat',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('fails waiting readers when stream aborts', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-4',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    const iterator = session[Symbol.asyncIterator]();
    const nextChunk = iterator.next().catch((error: unknown) => error);
    const closed = session.closed.catch((error: unknown) => error);

    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'abort',
      reason: 'boom',
    });

    expect(await nextChunk).toBeInstanceOf(OpenStreamAbortError);
    expect(await closed).toBeInstanceOf(OpenStreamAbortError);
  });
});
