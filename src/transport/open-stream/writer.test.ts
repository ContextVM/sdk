import { describe, expect, test } from 'bun:test';
import type { OpenStreamProgress } from './types.js';
import { OpenStreamWriter } from './writer.js';

/** Polls `condition` until it returns true or `timeoutMs` elapses. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!condition()) {
    throw new Error('waitFor condition never became true');
  }
}

describe('OpenStreamWriter', () => {
  test('hasStarted reflects whether the writer has emitted a start/chunk frame', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-started',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
    });

    // A freshly-created writer is "active" but has not begun streaming.
    expect(writer.isActive).toBe(true);
    expect(writer.hasStarted).toBe(false);

    // Control frames (ping/pong) do not start the stream.
    await writer.ping();
    await writer.pong('nonce');
    expect(writer.hasStarted).toBe(false);

    await writer.write('hello');
    expect(writer.hasStarted).toBe(true);
  });

  test('hasStarted becomes true after an explicit start()', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-explicit-start',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
    });

    expect(writer.hasStarted).toBe(false);

    await writer.start();

    expect(writer.hasStarted).toBe(true);
    expect(frames.map((frame) => frame.cvm.frameType)).toContain('start');
  });

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

    expect(frames[frames.length - 1]).toMatchObject({
      cvm: {
        type: 'open-stream',
        frameType: 'abort',
        reason: 'done',
      },
    });
    expect(lifecycle).toEqual(['close', 'abort:done']);
  });

  test('publishes abort before running abort lifecycle hook', async () => {
    const events: string[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-abort-order',
      publishFrame: async (frame): Promise<string | undefined> => {
        events.push(`publish:${frame.cvm.frameType}`);
        return undefined;
      },
      onAbort: async (reason?: string): Promise<void> => {
        events.push(`abort:${reason ?? ''}`);
      },
    });

    await writer.abort('ordered');

    expect(events).toEqual(['publish:abort', 'abort:ordered']);
  });

  test('retries start when the first start publish fails', async () => {
    const frames: OpenStreamProgress[] = [];
    let shouldFailStart = true;
    const writer = new OpenStreamWriter({
      progressToken: 'token-start-retry',
      publishFrame: async (frame): Promise<string | undefined> => {
        if (frame.cvm.frameType === 'start' && shouldFailStart) {
          shouldFailStart = false;
          throw new Error('relay unavailable');
        }

        frames.push(frame);
        return undefined;
      },
    });

    await expect(writer.start()).rejects.toThrow('relay unavailable');
    await writer.write('hello');

    expect(frames.map((frame) => frame.cvm.frameType)).toEqual([
      'start',
      'chunk',
    ]);
  });

  test('runs close lifecycle cleanup when close publish fails', async () => {
    const lifecycle: string[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-close-failure-cleanup',
      publishFrame: async (frame): Promise<string | undefined> => {
        if (frame.cvm.frameType === 'close') {
          throw new Error('close publish failed');
        }

        return undefined;
      },
      onClose: async (): Promise<void> => {
        lifecycle.push('close');
      },
    });

    await expect(writer.close()).rejects.toThrow('close publish failed');

    expect(writer.isActive).toBe(false);
    expect(lifecycle).toEqual(['close']);
  });

  test('runs abort lifecycle cleanup when abort publish fails', async () => {
    const lifecycle: string[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-abort-failure-cleanup',
      publishFrame: async (frame): Promise<string | undefined> => {
        if (frame.cvm.frameType === 'abort') {
          throw new Error('abort publish failed');
        }

        return undefined;
      },
      onAbort: async (reason?: string): Promise<void> => {
        lifecycle.push(`abort:${reason ?? ''}`);
      },
    });

    await expect(writer.abort('cleanup')).rejects.toThrow(
      'abort publish failed',
    );

    expect(writer.isActive).toBe(false);
    expect(lifecycle).toEqual(['abort:cleanup']);
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

describe('OpenStreamWriter keepalive', () => {
  test('aborts the writer with "Probe timeout" when the peer never acks', async () => {
    const frames: OpenStreamProgress[] = [];
    const aborts: Array<string | undefined> = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-keepalive-timeout',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
      onAbort: async (reason?: string): Promise<void> => {
        aborts.push(reason);
      },
      idleTimeoutMs: 10,
      probeTimeoutMs: 10,
    });

    await writer.start();
    await waitFor(() => !writer.isActive);

    expect(writer.isActive).toBe(false);
    expect(aborts).toEqual(['Probe timeout']);
    const types = frames.map((frame) => frame.cvm.frameType);
    expect(types).toContain('start');
    expect(types).toContain('ping');
    expect(types.filter((type) => type === 'abort')).toHaveLength(1);
  });

  test('stays alive while the peer acks each keepalive probe', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-keepalive-ack',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
      idleTimeoutMs: 10,
      probeTimeoutMs: 20,
    });

    await writer.start();

    // Act as a live peer: ack every probe nonce as soon as it is published.
    const acked = new Set<string>();
    const until = Date.now() + 120;
    while (Date.now() < until) {
      for (const frame of frames) {
        if (
          frame.cvm.frameType === 'ping' &&
          !acked.has(frame.cvm.nonce)
        ) {
          acked.add(frame.cvm.nonce);
          writer.ackProbe(frame.cvm.nonce);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    expect(writer.isActive).toBe(true);
    writer.dispose();
  });

  test('ignores ackProbe for a nonce that does not match the pending probe', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-keepalive-bad-ack',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
      idleTimeoutMs: 10,
      probeTimeoutMs: 10,
    });

    await writer.start();
    await waitFor(() =>
      frames.some((frame) => frame.cvm.frameType === 'ping'),
    );

    writer.ackProbe('not-the-pending-nonce');

    await waitFor(() => !writer.isActive);
    expect(writer.isActive).toBe(false);
  });

  test('dispose clears keepalive timers without publishing an abort', async () => {
    const frames: OpenStreamProgress[] = [];
    const writer = new OpenStreamWriter({
      progressToken: 'token-keepalive-dispose',
      publishFrame: async (frame): Promise<string | undefined> => {
        frames.push(frame);
        return undefined;
      },
      onAbort: async (): Promise<void> => {
        throw new Error('onAbort must not run during dispose');
      },
      idleTimeoutMs: 10,
      probeTimeoutMs: 10,
    });

    await writer.start();
    writer.dispose();

    expect(writer.isActive).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(frames.map((frame) => frame.cvm.frameType)).not.toContain('abort');
  });
});

describe('OpenStreamWriter signal', () => {
  test('aborts when the writer closes normally', async () => {
    const writer = new OpenStreamWriter({
      progressToken: 'token-signal-close',
      publishFrame: async (): Promise<string | undefined> => undefined,
    });
    expect(writer.signal.aborted).toBe(false);

    await writer.start();
    await writer.close();

    expect(writer.signal.aborted).toBe(true);
    expect(writer.isActive).toBe(false);
  });

  test('aborts and fires listeners on keepalive probe timeout', async () => {
    const writer = new OpenStreamWriter({
      progressToken: 'token-signal-probe',
      publishFrame: async (): Promise<string | undefined> => undefined,
      idleTimeoutMs: 10,
      probeTimeoutMs: 10,
    });
    let fired = false;
    writer.signal.addEventListener('abort', () => {
      fired = true;
    });

    await writer.start();
    await waitFor(() => writer.signal.aborted);

    expect(writer.signal.aborted).toBe(true);
    expect(fired).toBe(true);
  });

  test('aborts on dispose without running onAbort', async () => {
    const writer = new OpenStreamWriter({
      progressToken: 'token-signal-dispose',
      publishFrame: async (): Promise<string | undefined> => undefined,
      onAbort: async (): Promise<void> => {
        throw new Error('onAbort must not run during dispose');
      },
    });
    await writer.start();
    writer.dispose();

    expect(writer.signal.aborted).toBe(true);
  });
});
