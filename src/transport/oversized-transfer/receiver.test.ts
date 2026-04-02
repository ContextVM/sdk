import { describe, expect, test } from 'bun:test';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import {
  OversizedTransferIntegrityError,
  OversizedTransferProtocolError,
} from './errors.js';
import { OversizedTransferReceiver } from './receiver.js';
import { buildOversizedTransferFrames } from './sender.js';
import type { OversizedTransferProgressParams } from './types.js';

function toProgressNotification(
  params: OversizedTransferProgressParams,
): JSONRPCNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params,
  };
}

describe('OversizedTransferReceiver', () => {
  test('reassembles out-of-order chunks and returns the synthetic JSON-RPC message', () => {
    const receiver = new OversizedTransferReceiver();
    const payload = {
      jsonrpc: '2.0' as const,
      id: 'abc',
      result: { text: 'hello from oversized transfer' },
    };
    const serialized = JSON.stringify(payload);

    const { startFrame, chunkFrames, endFrame } = buildOversizedTransferFrames(
      serialized,
      {
        progressToken: 'token-r1',
        chunkSizeBytes: 8,
      },
    );

    expect(receiver.processFrame(toProgressNotification(startFrame))).toBeNull();

    const shuffled = [...chunkFrames].reverse();
    for (const chunkFrame of shuffled) {
      expect(receiver.processFrame(toProgressNotification(chunkFrame))).toBeNull();
    }

    const synthetic = receiver.processFrame(toProgressNotification(endFrame));
    expect(synthetic).toEqual(payload);
  });

  test('throws integrity error when digest does not match reassembled payload', () => {
    const receiver = new OversizedTransferReceiver();
    const serialized = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: 1 } });

    const { startFrame, chunkFrames, endFrame } = buildOversizedTransferFrames(
      serialized,
      {
        progressToken: 'token-r2',
        chunkSizeBytes: 16,
      },
    );

    if (startFrame.cvm.frameType !== 'start') {
      throw new Error('expected start frame');
    }

    const tamperedStart: OversizedTransferProgressParams = {
      ...startFrame,
      cvm: {
        ...startFrame.cvm,
        digest: 'sha256:deadbeef',
      },
    };

    receiver.processFrame(toProgressNotification(tamperedStart));
    for (const chunkFrame of chunkFrames) {
      receiver.processFrame(toProgressNotification(chunkFrame));
    }

    expect(() => receiver.processFrame(toProgressNotification(endFrame))).toThrow(
      OversizedTransferIntegrityError,
    );
  });

  test('throws protocol error when end arrives with missing chunks', () => {
    const receiver = new OversizedTransferReceiver();
    const serialized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { very: 'large payload' },
    });

    const { startFrame, chunkFrames, endFrame } = buildOversizedTransferFrames(
      serialized,
      {
        progressToken: 'token-r3',
        chunkSizeBytes: 6,
      },
    );

    receiver.processFrame(toProgressNotification(startFrame));
    receiver.processFrame(toProgressNotification(chunkFrames[0]!));

    expect(() => receiver.processFrame(toProgressNotification(endFrame))).toThrow(
      OversizedTransferProtocolError,
    );
  });

  test('resolves waitForAccept when accept arrives before waiter registration', async () => {
    const receiver = new OversizedTransferReceiver();

    const accept = toProgressNotification({
      progressToken: 'token-r4',
      progress: 2,
      cvm: {
        type: 'oversized-transfer',
        frameType: 'accept',
      },
    });

    receiver.processFrame(accept);

    await expect(receiver.waitForAccept('token-r4', 100)).resolves.toBeUndefined();
  });
});
