import { describe, expect, test } from 'bun:test';
import { createLogger } from '../../core/utils/logger.js';
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
});
