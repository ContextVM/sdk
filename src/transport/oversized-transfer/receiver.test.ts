import { describe, expect, test } from 'bun:test';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import { buildOversizedTransferFrames } from './sender.js';
import {
  OversizedTransferPolicyError,
  OversizedTransferReassemblyError,
  OversizedTransferReceiver,
  OversizedTransferSequenceError,
} from './index.js';
import type { Logger } from '../../core/utils/logger.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

function toNotification(params: {
  progressToken: string | number;
  progress: number;
  message?: string;
  total?: number;
  cvm: Record<string, unknown>;
}): JSONRPCNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params,
  };
}

describe('OversizedTransferReceiver', () => {
  test('reassembles valid out-of-order chunks within the configured window', async () => {
    const receiver = new OversizedTransferReceiver(
      {
        maxOutOfOrderWindow: 4,
        maxOutOfOrderChunks: 4,
      },
      testLogger,
    );

    const { startFrame, chunkFrames, endFrame } =
      await buildOversizedTransferFrames(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { value: 'abcdefghijklmnopqrst' },
        }),
        {
          progressToken: 'token-1',
          chunkSizeBytes: 20,
        },
      );

    expect(chunkFrames.length).toBeGreaterThanOrEqual(3);

    await receiver.processFrame(toNotification(startFrame));
    await receiver.processFrame(toNotification(chunkFrames[1]!));
    await receiver.processFrame(toNotification(chunkFrames[0]!));
    for (const chunkFrame of chunkFrames.slice(2)) {
      await receiver.processFrame(toNotification(chunkFrame));
    }

    const reconstructed = await receiver.processFrame(toNotification(endFrame));

    expect(reconstructed).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { value: 'abcdefghijklmnopqrst' },
    });
  });

  test('reassembles valid accept-gated transfers', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    const { startFrame, chunkFrames, endFrame } =
      await buildOversizedTransferFrames(
        JSON.stringify({ jsonrpc: '2.0', id: 6, result: { ok: true } }),
        {
          progressToken: 'token-6',
          chunkSizeBytes: 10,
          needsAcceptHandshake: true,
        },
      );

    await receiver.processFrame(toNotification(startFrame));
    await receiver.processFrame(
      toNotification({
        progressToken: 'token-6',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'accept',
        },
      }),
    );
    for (const chunkFrame of chunkFrames) {
      await receiver.processFrame(toNotification(chunkFrame));
    }

    const reconstructed = await receiver.processFrame(toNotification(endFrame));

    expect(reconstructed).toEqual({
      jsonrpc: '2.0',
      id: 6,
      result: { ok: true },
    });
  });

  test('fails when first chunk skips beyond the reserved accept slot', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-2',
        progress: 1,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 4,
          totalChunks: 1,
        },
      }),
    );

    await expect(
      receiver.processFrame(
        toNotification({
          progressToken: 'token-2',
          progress: 4,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'chunk',
            data: 'test',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(OversizedTransferSequenceError);
  });

  test('fails when the out-of-order gap exceeds policy', async () => {
    const receiver = new OversizedTransferReceiver(
      {
        maxOutOfOrderWindow: 1,
      },
      testLogger,
    );

    const { startFrame, chunkFrames } = await buildOversizedTransferFrames(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        result: { value: 'abcdefghijkl' },
      }),
      {
        progressToken: 'token-3',
        chunkSizeBytes: 4,
      },
    );

    await receiver.processFrame(toNotification(startFrame));

    await expect(
      receiver.processFrame(toNotification(chunkFrames[2]!)),
    ).rejects.toBeInstanceOf(OversizedTransferPolicyError);
  });

  test('accepts duplicate identical chunks as idempotent', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-duplicate-identical',
        progress: 1,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 8,
          totalChunks: 2,
        },
      }),
    );

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-duplicate-identical',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'chunk',
          data: 'abcd',
        },
      }),
    );

    await expect(
      receiver.processFrame(
        toNotification({
          progressToken: 'token-duplicate-identical',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'chunk',
            data: 'abcd',
          },
        }),
      ),
    ).resolves.toBeNull();
  });

  test('fails when accept progress does not advance past start', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-accept-order',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 4,
          totalChunks: 1,
        },
      }),
    );

    await expect(
      receiver.processFrame(
        toNotification({
          progressToken: 'token-accept-order',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'accept',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(OversizedTransferSequenceError);
  });

  test('does not resolve the accept waiter when the accept frame is invalid', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-accept-waiter-invalid',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 4,
          totalChunks: 1,
        },
      }),
    );

    const acceptPromise = receiver.waitForAccept(
      'token-accept-waiter-invalid',
      10,
    );

    await expect(
      receiver.processFrame(
        toNotification({
          progressToken: 'token-accept-waiter-invalid',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'accept',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(OversizedTransferSequenceError);

    await expect(acceptPromise).rejects.toBeInstanceOf(
      OversizedTransferSequenceError,
    );
  });

  test('resolves waitForAccept when accept arrived before waiter registration', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-accept-race',
        progress: 1,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 4,
          totalChunks: 1,
        },
      }),
    );

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-accept-race',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'accept',
        },
      }),
    );

    await expect(receiver.waitForAccept('token-accept-race')).resolves.toBe(
      undefined,
    );
  });

  test('fails when end arrives while chunk gaps remain unresolved', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    const { startFrame, chunkFrames, endFrame } =
      await buildOversizedTransferFrames(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          result: { value: 'abcdefghijkl' },
        }),
        {
          progressToken: 'token-4',
          chunkSizeBytes: 4,
        },
      );

    await receiver.processFrame(toNotification(startFrame));
    await receiver.processFrame(toNotification(chunkFrames[1]!));

    await expect(
      receiver.processFrame(toNotification(endFrame)),
    ).rejects.toBeInstanceOf(OversizedTransferReassemblyError);
  });

  test('fails when end progress does not advance past prior frames', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-end-order',
        progress: 1,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 4,
          totalChunks: 1,
        },
      }),
    );

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-end-order',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'chunk',
          data: 'test',
        },
      }),
    );

    await expect(
      receiver.processFrame(
        toNotification({
          progressToken: 'token-end-order',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'end',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(OversizedTransferSequenceError);
  });

  test('fails on conflicting duplicate chunk payloads', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-5',
        progress: 1,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 8,
          totalChunks: 2,
        },
      }),
    );

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-5',
        progress: 2,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'chunk',
          data: 'abcd',
        },
      }),
    );

    await expect(
      receiver.processFrame(
        toNotification({
          progressToken: 'token-5',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'chunk',
            data: 'wxyz',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(OversizedTransferSequenceError);
  });

  test('enforces the concurrent active transfer policy limit', async () => {
    const receiver = new OversizedTransferReceiver(
      { maxConcurrentTransfers: 1 },
      testLogger,
    );

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-concurrency-1',
        progress: 1,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 4,
          totalChunks: 1,
        },
      }),
    );

    await expect(
      receiver.processFrame(
        toNotification({
          progressToken: 'token-concurrency-2',
          progress: 1,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'start',
            completionMode: 'render',
            digest: 'sha256:efgh',
            totalBytes: 4,
            totalChunks: 1,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(OversizedTransferPolicyError);
  });

  test('clear rejects accept waiters and releases transfer state', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    await receiver.processFrame(
      toNotification({
        progressToken: 'token-clear',
        progress: 1,
        cvm: {
          type: 'oversized-transfer',
          frameType: 'start',
          completionMode: 'render',
          digest: 'sha256:abcd',
          totalBytes: 4,
          totalChunks: 1,
        },
      }),
    );

    const acceptPromise = receiver.waitForAccept('token-clear');

    receiver.clear();

    await expect(acceptPromise).rejects.toThrow('Receiver cleared');
    expect(receiver.activeTransferCount).toBe(0);
  });

  test('ignores orphan late frames after transfer cleanup', async () => {
    const receiver = new OversizedTransferReceiver({}, testLogger);

    expect(
      await receiver.processFrame(
        toNotification({
          progressToken: 'token-orphan-accept',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'accept',
          },
        }),
      ),
    ).toBeNull();

    expect(
      await receiver.processFrame(
        toNotification({
          progressToken: 'token-orphan-chunk',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'chunk',
            data: 'test',
          },
        }),
      ),
    ).toBeNull();

    expect(
      await receiver.processFrame(
        toNotification({
          progressToken: 'token-orphan-end',
          progress: 2,
          cvm: {
            type: 'oversized-transfer',
            frameType: 'end',
          },
        }),
      ),
    ).toBeNull();
  });
});
