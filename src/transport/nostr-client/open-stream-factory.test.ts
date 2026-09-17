import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCMessage,
  JSONRPCNotification,
} from '@contextvm/mcp-sdk/types.js';
import { createLogger } from '../../core/utils/logger.js';
import {
  buildOpenStreamAbortFrame,
  buildOpenStreamAcceptFrame,
} from '../open-stream/index.js';
import { ClientOpenStreamFactory } from './open-stream-factory.js';

function progressNotification(
  params: Record<string, unknown>,
): JSONRPCNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params,
  };
}

describe('ClientOpenStreamFactory', () => {
  test('server abort terminates the writer without a second abort frame and frees the token', async () => {
    const published: Array<Record<string, unknown>> = [];
    const factory = new ClientOpenStreamFactory({
      openStreamEnabled: true,
      send: async (message: JSONRPCMessage) => {
        const { method, params } = message as {
          method: string;
          params?: Record<string, unknown>;
        };
        if (method === 'notifications/progress' && params) {
          published.push(params);
        }
      },
      logger: createLogger('test', { level: 'silent' }),
    });
    const receiver = factory.getReceiver();

    const handle = factory.startStream('token-aborted-upload');
    await receiver.processFrame(
      progressNotification(
        buildOpenStreamAcceptFrame({
          progressToken: 'token-aborted-upload',
          progress: 1,
        }),
      ),
    );
    const { session, writer } = await handle;
    expect(writer.isActive).toBe(true);

    await receiver.processFrame(
      progressNotification(
        buildOpenStreamAbortFrame({
          progressToken: 'token-aborted-upload',
          progress: 2,
        }),
      ),
    );
    await session.closed.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(writer.isActive).toBe(false);
    expect(writer.signal.aborted).toBe(true);

    // Exactly one client frame was published (start); the writer must not
    // echo an abort for a stream the server already terminated.
    expect(published).toEqual([
      expect.objectContaining({
        cvm: expect.objectContaining({ frameType: 'start' }),
      }),
    ]);

    // Cleanup freed the token: a new stream on it restarts the client's
    // per-sender sequence at 1.
    const second = factory.startStream('token-aborted-upload');
    await receiver.processFrame(
      progressNotification(
        buildOpenStreamAcceptFrame({
          progressToken: 'token-aborted-upload',
          progress: 1,
        }),
      ),
    );
    await second;
    expect(published[1]).toMatchObject({ progress: 1 });

    receiver.clear();
  });

  test('a failed start publish terminates the session instead of leaking it', async () => {
    let failPublish = true;
    const factory = new ClientOpenStreamFactory({
      openStreamEnabled: true,
      send: async (): Promise<void> => {
        if (failPublish) {
          throw new Error('relay unavailable');
        }
      },
      logger: createLogger('test', { level: 'silent' }),
    });

    await expect(factory.startStream('token-failed-start')).rejects.toThrow(
      'relay unavailable',
    );

    const session = factory.getSession('token-failed-start');
    expect(session).toBeUndefined();
  });
});
