import { describe, expect, test } from 'bun:test';
import { createLogger } from '../../core/utils/logger.js';
import {
  DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM,
  DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM,
} from './constants.js';
import { OpenStreamPolicyError, OpenStreamSequenceError } from './errors.js';
import { OpenStreamRegistry } from './registry.js';
import type { OpenStreamProgress } from './types.js';

describe('OpenStreamRegistry', () => {
  test('enforces the max concurrent stream policy and reuses slots after close', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 1,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });

    const first = registry.createSession('token-1');

    expect(() => registry.createSession('token-2')).toThrow(
      OpenStreamPolicyError,
    );

    await first.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await first.processFrame(2, {
      type: 'open-stream',
      frameType: 'close',
    });
    await first.closed;

    const second = registry.createSession('token-2');

    expect(second.progressToken).toBe('token-2');
    expect(registry.size).toBe(1);
  });

  test('reuses the same session instance for repeated getOrCreate calls', () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 2,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });

    const first = registry.getOrCreateSession('token-shared');
    const second = registry.getOrCreateSession('token-shared');

    expect(second).toBe(first);
    expect(registry.size).toBe(1);
  });

  test('rejects non-start frames for unknown progress tokens', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 2,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });

    await expect(
      registry.processFrame({
        progressToken: 'token-missing-start',
        progress: 1,
        cvm: {
          type: 'open-stream',
          frameType: 'chunk',
          chunkIndex: 0,
          data: 'orphan',
        },
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);

    expect(registry.getSession('token-missing-start')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  test('terminates a session when frame processing fails after creation', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 2,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 4,
      logger: createLogger('test', { level: 'silent' }),
    });

    const session = await registry.processFrame({
      progressToken: 'token-processing-failure',
      progress: 1,
      cvm: {
        type: 'open-stream',
        frameType: 'start',
      },
    });
    const closed = session.closed.catch((error: unknown) => error);

    await expect(
      registry.processFrame({
        progressToken: 'token-processing-failure',
        progress: 2,
        cvm: {
          type: 'open-stream',
          frameType: 'chunk',
          chunkIndex: 1,
          data: 'hello',
        },
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);

    expect(await closed).toBeInstanceOf(OpenStreamSequenceError);
    expect(registry.getSession('token-processing-failure')).toBeUndefined();
  });

  test('applies default buffering limits when a session is created without overrides', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 2,
      logger: createLogger('test', { level: 'silent' }),
    });

    const session = registry.createSession('token-default-bounds');

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    for (let i = 0; i < DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM; i += 1) {
      await session.processFrame(i + 2, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: i + 1,
        data: 'x',
      });
    }

    await expect(
      session.processFrame(DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM + 2, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM + 1,
        data: 'x',
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);

    const byteLimited = registry.createSession('token-default-bytes');
    await byteLimited.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    await expect(
      byteLimited.processFrame(2, {
        type: 'open-stream',
        frameType: 'chunk',
        chunkIndex: 1,
        data: 'x'.repeat(DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM + 1),
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);
  });

  test('applies default timer limits when a session is created without overrides', async () => {
    const pings: string[] = [];
    const pongs: string[] = [];
    const aborts: Array<string | undefined> = [];
    const registry = new OpenStreamRegistry({
      logger: createLogger('test', { level: 'silent' }),
      getSessionOptions: () => ({
        sendPing: async (nonce: string): Promise<void> => {
          pings.push(nonce);
        },
        sendPong: async (nonce: string): Promise<void> => {
          pongs.push(nonce);
        },
        sendAbort: async (reason?: string): Promise<void> => {
          aborts.push(reason);
        },
      }),
    });

    const session = registry.createSession('token-default-timers');

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });
    await session.processFrame(2, {
      type: 'open-stream',
      frameType: 'ping',
      nonce: 'peer-nonce',
    });

    expect(pings).toEqual([]);
    expect(pongs).toEqual(['peer-nonce']);
    expect(aborts).toEqual([]);
  });

  test('clearing the registry disposes active sessions and cancels pending timers', async () => {
    const pings: string[] = [];
    const aborts: Array<string | undefined> = [];
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 2,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      idleTimeoutMs: 10,
      probeTimeoutMs: 10,
      logger: createLogger('test', { level: 'silent' }),
      getSessionOptions: () => ({
        sendPing: async (nonce: string): Promise<void> => {
          pings.push(nonce);
        },
        sendAbort: async (reason?: string): Promise<void> => {
          aborts.push(reason);
        },
      }),
    });

    const session = registry.createSession('token-clear-disposes');

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    registry.clear();

    await expect(session.closed).resolves.toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(registry.size).toBe(0);
    expect(pings).toEqual([]);
    expect(aborts).toEqual([]);
  });

  test('accepts a start frame with advisory metadata omitted', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 2,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });

    const session = await registry.processFrame({
      progressToken: 'token-advisory-start',
      progress: 1,
      cvm: {
        type: 'open-stream',
        frameType: 'start',
      },
    });

    expect(session.progressToken).toBe('token-advisory-start');
    expect(registry.getSession('token-advisory-start')).toBe(session);

    registry.clear();
    await expect(session.closed).resolves.toBeUndefined();
  });

  test('rejects malformed progress payloads that are not CEP-41 frames', () => {
    const malformedPayloads: unknown[] = [
      null,
      {},
      { progressToken: 'missing-cvm', progress: 1 },
      {
        progressToken: 'wrong-type',
        progress: 1,
        cvm: { type: 'other', frameType: 'start' },
      },
      {
        progressToken: 'missing-frame-type',
        progress: 1,
        cvm: { type: 'open-stream' },
      },
    ];

    expect(
      malformedPayloads.every(
        (payload) => !OpenStreamRegistry.isOpenStreamProgress(payload),
      ),
    ).toBe(true);
  });

  test('publishes abort to the peer when an inbound frame fails the stream', async () => {
    const registry = new OpenStreamRegistry({
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });
    const publishedAborts: Array<{ progress: number; reason?: string }> = [];
    const session = registry.createSession({
      progressToken: 'token-seq-fail',
      sendAbort: async (reason?: string): Promise<void> => {
        publishedAborts.push({ progress: 0, reason });
      },
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    // Non-monotonic progress fails the stream and must reach the peer.
    await expect(
      registry.processFrame({
        progressToken: 'token-seq-fail',
        progress: 1,
        cvm: { type: 'open-stream', frameType: 'ping', nonce: 'n1' },
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);

    expect(publishedAborts.length).toBe(1);
    expect(publishedAborts[0]?.reason).toContain('Non-increasing progress');
    expect(registry.getSession('token-seq-fail')).toBeUndefined();
  });

  test('rejects accepted when the stream closes before the peer accepts', async () => {
    const registry = new OpenStreamRegistry({
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });
    const session = registry.createSession({
      progressToken: 'token-close-before-accept',
      locallyInitiated: true,
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'close',
    });

    await expect(session.accepted).rejects.toThrow(
      'closed before accept',
    );
  });

  test('invokes derived lifecycle hooks from getSessionOptions on close and abort', async () => {
    const events: string[] = [];
    const registry = new OpenStreamRegistry({
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
      getSessionOptions: (progressToken) => ({
        onClose: async (): Promise<void> => {
          events.push(`derived-close:${progressToken}`);
        },
        onAbort: async (): Promise<void> => {
          events.push(`derived-abort:${progressToken}`);
        },
      }),
    });

    const closed = registry.createSession('token-derived-close');
    await closed.processFrame(1, { type: 'open-stream', frameType: 'start' });
    await closed.processFrame(2, { type: 'open-stream', frameType: 'close' });
    await closed.closed;

    await registry.processFrame({
      progressToken: 'token-derived-abort',
      progress: 1,
      cvm: { type: 'open-stream', frameType: 'start' },
    });
    await expect(
      registry.processFrame({
        progressToken: 'token-derived-abort',
        progress: 2,
        cvm: { type: 'open-stream', frameType: 'start' },
      }),
    ).rejects.toBeInstanceOf(OpenStreamSequenceError);

    expect(events).toContain('derived-close:token-derived-close');
    expect(events).toEqual(
      expect.arrayContaining(['derived-abort:token-derived-abort']),
    );
    expect(registry.size).toBe(0);
  });

  test('still removes the session when the abort publish fails', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 1,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
      getSessionOptions: () => ({
        sendAbort: async (): Promise<void> => {
          throw new Error('publish failed');
        },
      }),
    });

    await registry.processFrame({
      progressToken: 'token-abort-publish-failure',
      progress: 1,
      cvm: { type: 'open-stream', frameType: 'start' },
    });

    await expect(
      registry.processFrame({
        progressToken: 'token-abort-publish-failure',
        progress: 2,
        cvm: { type: 'open-stream', frameType: 'start' },
      }),
    ).rejects.toThrow('publish failed');

    expect(
      registry.getSession('token-abort-publish-failure'),
    ).toBeUndefined();
    expect(() => registry.createSession('token-after-failed-abort')).not.toThrow();
  });

  test('rejects accept as the first frame for an unknown token', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 2,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });
    const acceptFrame: OpenStreamProgress = {
      progressToken: 'token-orphan-accept',
      progress: 1,
      cvm: {
        type: 'open-stream',
        frameType: 'accept',
      },
    };

    await expect(registry.processFrame(acceptFrame)).rejects.toBeInstanceOf(
      OpenStreamSequenceError,
    );
    expect(registry.getSession('token-orphan-accept')).toBeUndefined();
  });

  test('removes sessions even when onClose callback throws', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 1,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });

    const session = registry.createSession({
      progressToken: 'token-close-throws',
      onClose: async (): Promise<void> => {
        throw new Error('close failed');
      },
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

    expect(registry.getSession('token-close-throws')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  test('removes sessions even when onAbort callback throws', async () => {
    const registry = new OpenStreamRegistry({
      maxConcurrentStreams: 1,
      maxBufferedChunksPerStream: 4,
      maxBufferedBytesPerStream: 128,
      logger: createLogger('test', { level: 'silent' }),
    });

    const session = registry.createSession({
      progressToken: 'token-abort-throws',
      onAbort: async (): Promise<void> => {
        throw new Error('abort failed');
      },
    });

    await session.processFrame(1, {
      type: 'open-stream',
      frameType: 'start',
    });

    const closed = session.closed.catch((error: unknown) => error);

    await expect(
      session.processFrame(2, {
        type: 'open-stream',
        frameType: 'abort',
        reason: 'boom',
      }),
    ).rejects.toThrow('abort failed');

    expect(await closed).toBeInstanceOf(Error);

    expect(registry.getSession('token-abort-throws')).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});
