import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCMessage,
  JSONRPCResponse,
} from '@contextvm/mcp-sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';
import type { CorrelationStore } from './correlation-store.js';
import type { SessionStore } from './session-store.js';
import { ServerOpenStreamFactory } from './open-stream-factory.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

const correlationStore = {
  getEventIdByProgressToken: () => undefined,
  getEventRoute: () => undefined,
} as unknown as CorrelationStore;

const sessionStore = {
  getSession: () => undefined,
  removeSession: () => false,
} as unknown as SessionStore;

function createFactory(options?: { openStreamEnabled?: boolean }): {
  factory: ServerOpenStreamFactory;
  notifications: Array<{ clientPubkey: string; notification: JSONRPCMessage }>;
  routedResponses: JSONRPCResponse[];
} {
  const notifications: Array<{
    clientPubkey: string;
    notification: JSONRPCMessage;
  }> = [];
  const routedResponses: JSONRPCResponse[] = [];

  const factory = new ServerOpenStreamFactory({
    openStreamEnabled: options?.openStreamEnabled ?? true,
    sessionStore,
    correlationStore,
    sendNotification: async (clientPubkey, notification) => {
      notifications.push({ clientPubkey, notification });
    },
    handleResponse: async (response) => {
      routedResponses.push(response);
    },
    logger: testLogger,
  });

  return { factory, notifications, routedResponses };
}

const sampleResponse = (id: string): JSONRPCResponse => ({
  jsonrpc: '2.0',
  id,
  result: { ok: true },
});

describe('ServerOpenStreamFactory.deferIfStreamActive', () => {
  test('does not defer when no writer exists', () => {
    const { factory } = createFactory();

    expect(factory.deferIfStreamActive('evt-1', sampleResponse('evt-1'))).toBe(
      false,
    );
    expect(factory.getPendingResponsesMap().has('evt-1')).toBe(false);
  });

  test('does not defer for a writer the tool never streamed to, and drops it', () => {
    const { factory } = createFactory();

    factory.createWriterIfEnabled('evt-2', 'a'.repeat(64), 'token-unused');
    // Writer exists and is "active", but the tool never wrote to it.
    expect(factory.getWriter('evt-2')?.isActive).toBe(true);
    expect(factory.getWriter('evt-2')?.hasStarted).toBe(false);

    const deferred = factory.deferIfStreamActive(
      'evt-2',
      sampleResponse('evt-2'),
    );

    expect(deferred).toBe(false);
    // Response is not stashed...
    expect(factory.getPendingResponsesMap().has('evt-2')).toBe(false);
    // ...and the unused writer is cleaned up so it cannot leak.
    expect(factory.getWriter('evt-2')).toBeUndefined();
    expect(factory.getWritersMap().has('evt-2')).toBe(false);
  });

  test('defers the response once the tool has started streaming', async () => {
    const { factory, routedResponses } = createFactory();

    factory.createWriterIfEnabled('evt-3', 'b'.repeat(64), 'token-streamed');
    const writer = factory.getWriter('evt-3');
    expect(writer).toBeDefined();
    await writer!.start();
    expect(writer!.hasStarted).toBe(true);

    const deferred = factory.deferIfStreamActive(
      'evt-3',
      sampleResponse('evt-3'),
    );

    expect(deferred).toBe(true);
    expect(factory.getPendingResponsesMap().has('evt-3')).toBe(true);
    // Nothing routed yet: response waits for the stream to terminate.
    expect(routedResponses).toHaveLength(0);

    await writer!.close();

    expect(routedResponses).toHaveLength(1);
    expect(routedResponses[0]).toMatchObject({ id: 'evt-3' });
    expect(factory.getPendingResponsesMap().has('evt-3')).toBe(false);
    expect(factory.getWritersMap().has('evt-3')).toBe(false);
  });

  test('never-created writers are skipped when open-stream is disabled', () => {
    const { factory } = createFactory({ openStreamEnabled: false });

    factory.createWriterIfEnabled('evt-4', 'c'.repeat(64), 'token-disabled');
    // No writer is registered while the feature is disabled.
    expect(factory.getWriter('evt-4')).toBeUndefined();
    expect(factory.deferIfStreamActive('evt-4', sampleResponse('evt-4'))).toBe(
      false,
    );
  });
});
