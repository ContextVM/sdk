import { describe, expect, test } from 'bun:test';
import { createLogger } from '../../core/utils/logger.js';
import {
  DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM,
  DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM,
} from './constants.js';
import { OpenStreamPolicyError, OpenStreamSequenceError } from './errors.js';
import { OpenStreamRegistry } from './registry.js';

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
});
