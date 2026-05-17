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

  test('fails when buffered chunk count exceeds the configured limit', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-buffer-count',
      maxBufferedChunks: 1,
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
      data: 'late',
    });

    await expect(
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 2,
        data: 'later',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('fails when buffered byte count exceeds the configured limit', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-buffer-bytes',
      maxBufferedChunks: 4,
      maxBufferedBytes: 4,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await expect(
      session.processFrame(2, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 1,
        data: 'hello',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('uses UTF-8 byte accounting without relying on Buffer', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-utf8-byte-accounting',
      maxBufferedChunks: 4,
      maxBufferedBytes: 4,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 0,
      data: 'éé',
    });

    await expect(
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 1,
        data: 'a',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('fail terminates the iterator and closed promise with the provided error', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-explicit-fail',
      maxBufferedChunks: 4,
      maxBufferedBytes: 16,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    const iterator = session[Symbol.asyncIterator]();
    const nextChunk = iterator.next().catch((error: unknown) => error);
    const closed = session.closed.catch((error: unknown) => error);
    const error = new OpenStreamSequenceError('synthetic failure');

    await session.fail(error);

    expect(await nextChunk).toBe(error);
    expect(await closed).toBe(error);
  });

  test('counts unread queued chunks against the buffered byte limit', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-queued-bytes',
      maxBufferedChunks: 4,
      maxBufferedBytes: 5,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 0,
      data: 'abc',
    });

    await expect(
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 1,
        data: 'def',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('releases queued byte budget after queued chunks are consumed', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-queued-byte-release',
      maxBufferedChunks: 4,
      maxBufferedBytes: 6,
    });
    const iterator = session[Symbol.asyncIterator]();

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 0,
      data: 'abc',
    });
    await session.processFrame(3, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 1,
      data: 'def',
    });

    await expect(
      session.processFrame(4, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 2,
        data: 'g',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);

    const first = await iterator.next();
    expect(first).toEqual({
      done: false,
      value: { value: 'abc', chunkIndex: 0 },
    });

    await session.processFrame(5, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 2,
      data: 'g',
    });
  });

  test('rejects frames after close', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-post-close',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'close',
    });
    await expect(session.closed).resolves.toBeUndefined();

    await expect(
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 0,
        data: 'late',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('rejects frames after abort', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-post-abort',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'abort',
      reason: 'boom',
    });
    await expect(session.closed).rejects.toBeInstanceOf(OpenStreamAbortError);

    await expect(
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 0,
        data: 'late',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);

    await expect(
      session.processFrame(4, {
        type: 'open-stream',
        frameType: 'close',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('calls only onAbort when the stream aborts', async () => {
    const calls: string[] = [];
    const session = new OpenStreamSession({
      progressToken: 'token-abort-callbacks',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
      onClose: async (): Promise<void> => {
        calls.push('close');
      },
      onAbort: async (): Promise<void> => {
        calls.push('abort');
      },
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    const closed = session.closed.catch((error: unknown) => error);

    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'abort',
      reason: 'boom',
    });

    expect(calls).toEqual(['abort']);
    expect(await closed).toBeInstanceOf(OpenStreamAbortError);
  });

  test('rejects stale chunk indexes that were already flushed', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-stale-chunk',
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

    await expect(
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 0,
        data: 'late-duplicate',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('requires all chunks through close.lastChunkIndex before finishing', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-last-chunk-index',
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

    await expect(
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'close',
        lastChunkIndex: 1,
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('allows graceful close when close.lastChunkIndex matches received chunks', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-last-chunk-complete',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
      idleTimeoutMs: 1000,
      probeTimeoutMs: 1000,
      closeGracePeriodMs: 1000,
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
      frameType: 'close',
      lastChunkIndex: 0,
    });

    await expect(session.closed).resolves.toBeUndefined();
  });

  test('responds to ping frames with a matching pong', async () => {
    const pongs: string[] = [];
    const session = new OpenStreamSession({
      progressToken: 'token-ping-pong',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
      idleTimeoutMs: 100,
      probeTimeoutMs: 100,
      closeGracePeriodMs: 100,
      sendPong: async (nonce: string): Promise<void> => {
        pongs.push(nonce);
      },
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'ping',
      nonce: 'nonce-1',
    });

    expect(pongs).toEqual(['nonce-1']);

    session.dispose();
    await expect(session.closed).resolves.toBeUndefined();
  });

  test('sends ping after idle timeout and aborts after probe timeout', async () => {
    const pings: string[] = [];
    const aborts: Array<string | undefined> = [];
    const session = new OpenStreamSession({
      progressToken: 'token-probe-timeout',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
      idleTimeoutMs: 10,
      probeTimeoutMs: 10,
      closeGracePeriodMs: 100,
      sendPing: async (nonce: string): Promise<void> => {
        pings.push(nonce);
      },
      sendAbort: async (reason?: string): Promise<void> => {
        aborts.push(reason);
      },
    });
    const closed = session.closed.catch((error: unknown) => error);

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(pings).toHaveLength(1);
    expect(aborts).toEqual(['Probe timeout']);
    expect(await closed).toBeInstanceOf(OpenStreamAbortError);
  });

  test('clears the probe timeout when a matching pong arrives', async () => {
    const pings: string[] = [];
    const aborts: Array<string | undefined> = [];
    const session = new OpenStreamSession({
      progressToken: 'token-probe-success',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
      idleTimeoutMs: 10,
      probeTimeoutMs: 20,
      closeGracePeriodMs: 100,
      sendPing: async (nonce: string): Promise<void> => {
        pings.push(nonce);
      },
      sendAbort: async (reason?: string): Promise<void> => {
        aborts.push(reason);
      },
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(pings).toHaveLength(1);

    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'pong',
      nonce: pings[0]!,
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(aborts).toEqual([]);
    expect(session.isActive).toBe(true);

    await session.abort('test cleanup');
    await session.closed.catch(() => undefined);
  });

  test('ignores unexpected pong frames for liveness tracking', async () => {
    const pings: string[] = [];
    const aborts: Array<string | undefined> = [];
    const session = new OpenStreamSession({
      progressToken: 'token-invalid-pong',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
      idleTimeoutMs: 10,
      probeTimeoutMs: 10,
      closeGracePeriodMs: 100,
      sendPing: async (nonce: string): Promise<void> => {
        pings.push(nonce);
      },
      sendAbort: async (reason?: string): Promise<void> => {
        aborts.push(reason);
      },
    });
    const closed = session.closed.catch((error: unknown) => error);

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(pings).toHaveLength(1);

    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'pong',
      nonce: 'unexpected-pong',
    });

    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(aborts).toEqual(['Probe timeout']);
    expect(await closed).toBeInstanceOf(OpenStreamAbortError);
  });

  test('aborts when close grace period expires with missing chunks', async () => {
    const aborts: Array<string | undefined> = [];
    const session = new OpenStreamSession({
      progressToken: 'token-close-grace-timeout',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
      idleTimeoutMs: 100,
      probeTimeoutMs: 100,
      closeGracePeriodMs: 10,
      sendAbort: async (reason?: string): Promise<void> => {
        aborts.push(reason);
      },
    });
    const closed = session.closed.catch((error: unknown) => error);

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'chunk',
      chunkIndex: 1,
      data: 'late',
    });
    await session.processFrame(3, {
      type: 'open-stream',
      frameType: 'close',
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(aborts).toEqual(['Close grace period expired']);
    expect(await closed).toBeInstanceOf(OpenStreamAbortError);
  });

  test('keeps ordered delivery when chunk and close are processed concurrently', async () => {
    const session = new OpenStreamSession({
      progressToken: 'token-concurrent-order',
      maxBufferedChunks: 8,
      maxBufferedBytes: 1024,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await Promise.all([
      session.processFrame(2, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 0,
        data: 'hello',
      }),
      session.processFrame(3, {
        type: 'open-stream',
        frameType: 'close',
        lastChunkIndex: 0,
      }),
    ]);

    const chunks: string[] = [];
    for await (const chunk of session) {
      chunks.push(chunk.value);
    }

    expect(chunks).toEqual(['hello']);
    await expect(session.closed).resolves.toBeUndefined();
  });
});
