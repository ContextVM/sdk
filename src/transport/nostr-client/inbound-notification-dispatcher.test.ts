import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCResponse,
} from '@contextvm/mcp-sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';
import { waitFor } from '../../core/utils/test.utils.js';
import { ClientInboundNotificationDispatcher } from './inbound-notification-dispatcher.js';
import { OpenStreamReceiver } from '../open-stream/index.js';
import {
  OversizedTransferReceiver,
  buildOversizedTransferFrames,
} from '../oversized-transfer/index.js';
import type { OversizedTransferProgress } from '../oversized-transfer/types.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

interface ForwardedNotification {
  eventId: string;
  correlatedEventId: string | undefined;
  message: JSONRPCMessage;
}

interface HandledResponse {
  correlatedEventId: string;
  synthetic: JSONRPCResponse;
}

function toProgressNotification(
  frame: OversizedTransferProgress,
): JSONRPCNotification {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: frame,
  };
}

interface CapturedLog {
  message: string;
  data: unknown;
}

function createCapturingLogger(): {
  logger: Logger;
  warns: CapturedLog[];
} {
  const warns: CapturedLog[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, data) => {
      warns.push({ message, data });
    },
    error: () => undefined,
    withModule: () => logger,
  };
  return { logger, warns };
}

function setupDispatcher(logger: Logger = testLogger): {
  dispatcher: ClientInboundNotificationDispatcher;
  forwardedNotifications: ForwardedNotification[];
  handledResponses: HandledResponse[];
  oversizedReceiver: OversizedTransferReceiver;
  openStreamReceiver: OpenStreamReceiver;
} {
  const oversizedReceiver = new OversizedTransferReceiver({}, logger);
  const openStreamReceiver = new OpenStreamReceiver({
    logger,
  });
  const forwardedNotifications: ForwardedNotification[] = [];
  const handledResponses: HandledResponse[] = [];

  const dispatcher = new ClientInboundNotificationDispatcher({
    openStreamReceiver,
    oversizedReceiver,
    handleNotification: (eventId, correlatedEventId, message) => {
      forwardedNotifications.push({ eventId, correlatedEventId, message });
    },
    handleResponse: (correlatedEventId, synthetic) => {
      handledResponses.push({ correlatedEventId, synthetic });
    },
    logger,
  });

  return {
    dispatcher,
    forwardedNotifications,
    handledResponses,
    oversizedReceiver,
    openStreamReceiver,
  };
}

describe('ClientInboundNotificationDispatcher', () => {
  test('forwards every oversized progress frame as a notification and routes the reassembled response to handleResponse', async () => {
    // Regression for the missing `handleNotification` forwarding: progress
    // frames must reach the consumer so that resetTimeoutOnProgress keeps the
    // client request alive during a long oversized transfer (CEP-22).
    const {
      dispatcher,
      forwardedNotifications,
      handledResponses,
      openStreamReceiver,
    } = setupDispatcher();

    const payload: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: 42,
      result: { value: 'x'.repeat(64) },
    };
    const { startFrame, chunkFrames, endFrame } =
      await buildOversizedTransferFrames(JSON.stringify(payload), {
        progressToken: 'token-forward',
        chunkSizeBytes: 16,
      });

    const eventId = 'evt-frame';
    const correlatedEventId = 'evt-request';
    const allFrames: OversizedTransferProgress[] = [
      startFrame,
      ...chunkFrames,
      endFrame,
    ];

    for (const frame of allFrames) {
      const intercepted = dispatcher.tryIntercept(
        toProgressNotification(frame),
        eventId,
        correlatedEventId,
      );
      expect(intercepted).toBe(true);
    }

    // Forwarding is synchronous and covers every frame (start, chunks, end).
    expect(forwardedNotifications.map((entry) => entry.message)).toEqual(
      allFrames.map(toProgressNotification),
    );
    expect(
      forwardedNotifications.every(
        (entry) =>
          entry.eventId === eventId &&
          entry.correlatedEventId === correlatedEventId,
      ),
    ).toBe(true);

    // The reassembled result is correlated back asynchronously.
    await waitFor({ produce: () => handledResponses[0], timeoutMs: 1000 });
    expect(handledResponses).toEqual([
      { correlatedEventId, synthetic: payload },
    ]);

    openStreamReceiver.clear();
  });

  test('routes open-stream progress frames through the open-stream receiver and lets them fall through', () => {
    const {
      dispatcher,
      forwardedNotifications,
      handledResponses,
      oversizedReceiver,
      openStreamReceiver,
    } = setupDispatcher();

    const openStreamStart: JSONRPCNotification = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'stream-1',
        progress: 1,
        cvm: { type: 'open-stream', frameType: 'start' },
      },
    };

    const intercepted = dispatcher.tryIntercept(
      openStreamStart,
      'evt-stream',
      'evt-request',
    );

    expect(intercepted).toBe(false);
    expect(forwardedNotifications).toHaveLength(0);
    expect(handledResponses).toHaveLength(0);
    // The frame was consumed by the open-stream receiver, not the oversized one.
    expect(openStreamReceiver.getSession('stream-1')).toBeDefined();
    expect(oversizedReceiver.activeTransferCount).toBe(0);

    openStreamReceiver.clear();
  });

  test('routes a reassembled notification payload back through handleNotification (not handleResponse)', async () => {
    // A notification payload (rather than a result/error response) is forwarded
    // to the consumer via handleNotification with its synthetic form, while
    // handleResponse is left untouched.
    const {
      dispatcher,
      forwardedNotifications,
      handledResponses,
      openStreamReceiver,
    } = setupDispatcher();

    const payload: JSONRPCNotification = {
      jsonrpc: '2.0',
      method: 'notifications/resource_updated',
      params: { uri: 'x'.repeat(64) },
    };
    const { startFrame, chunkFrames, endFrame } =
      await buildOversizedTransferFrames(JSON.stringify(payload), {
        progressToken: 'token-notif',
        chunkSizeBytes: 16,
      });

    const eventId = 'evt-frame';
    const correlatedEventId = 'evt-request';
    const allFrames: OversizedTransferProgress[] = [
      startFrame,
      ...chunkFrames,
      endFrame,
    ];

    for (const frame of allFrames) {
      dispatcher.tryIntercept(
        toProgressNotification(frame),
        eventId,
        correlatedEventId,
      );
    }

    // Per-frame forwarding, plus the reassembled notification routed back.
    await waitFor({
      produce: () => forwardedNotifications[allFrames.length],
      timeoutMs: 1000,
    });
    expect(forwardedNotifications.map((entry) => entry.message)).toEqual([
      ...allFrames.map(toProgressNotification),
      payload,
    ]);
    // A notification payload must never be mistaken for a response.
    expect(handledResponses).toHaveLength(0);

    openStreamReceiver.clear();
  });

  test('warns and skips handleResponse when an oversized response completes without a correlation id', async () => {
    // Guards the warn branch: a result response that arrives without a
    // correlation `e` tag cannot be routed, so it is logged and dropped.
    const { logger, warns } = createCapturingLogger();
    const {
      dispatcher,
      forwardedNotifications,
      handledResponses,
      openStreamReceiver,
    } = setupDispatcher(logger);

    const payload: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: 7,
      result: { value: 'x'.repeat(64) },
    };
    const { startFrame, chunkFrames, endFrame } =
      await buildOversizedTransferFrames(JSON.stringify(payload), {
        progressToken: 'token-no-corr',
        chunkSizeBytes: 16,
      });

    const eventId = 'evt-frame';
    const allFrames: OversizedTransferProgress[] = [
      startFrame,
      ...chunkFrames,
      endFrame,
    ];

    for (const frame of allFrames) {
      dispatcher.tryIntercept(
        toProgressNotification(frame),
        eventId,
        undefined,
      );
    }

    // Progress forwarding is independent of the correlation id.
    expect(forwardedNotifications.map((entry) => entry.message)).toEqual(
      allFrames.map(toProgressNotification),
    );

    await waitFor({ produce: () => warns[0], timeoutMs: 1000 });
    expect(handledResponses).toHaveLength(0);
    expect(warns).toContainEqual({
      message: 'Oversized response completed without correlation `e` tag',
      data: { eventId },
    });

    openStreamReceiver.clear();
  });

  test('does not intercept notifications that do not carry a progress frame', () => {
    const { dispatcher, forwardedNotifications, handledResponses } =
      setupDispatcher();

    const initialized: JSONRPCNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };

    const intercepted = dispatcher.tryIntercept(
      initialized,
      'evt-misc',
      undefined,
    );

    expect(intercepted).toBe(false);
    expect(forwardedNotifications).toHaveLength(0);
    expect(handledResponses).toHaveLength(0);
  });
});
