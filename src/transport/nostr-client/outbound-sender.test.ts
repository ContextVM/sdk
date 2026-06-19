import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';
import type { ClientCorrelationStore } from './correlation-store.js';
import type { ClientCapabilityNegotiator } from '../capability-negotiator.js';
import {
  ClientOutboundSender,
  type ClientOutboundSenderDeps,
} from './outbound-sender.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

function createCapabilityNegotiator(): Pick<
  ClientCapabilityNegotiator,
  'buildOutboundTags' | 'chooseOutboundGiftWrapKind' | 'markNegotiationTagsSent'
> {
  return {
    buildOutboundTags: ({ baseTags }) => baseTags as string[][],
    chooseOutboundGiftWrapKind: () => 0,
    markNegotiationTagsSent: () => undefined,
  };
}

interface Harness {
  sender: ClientOutboundSender;
  sequence: string[];
  resolvedTokens: string[];
  registered: Array<{ eventId: string; token?: string }>;
  invokePublish: (eventId: string) => void;
}

function createHarness(options?: { oversizedEnabled?: boolean }): Harness {
  const sequence: string[] = [];
  const resolvedTokens: string[] = [];
  const registered: Array<{ eventId: string; token?: string }> = [];
  let pendingPublish: ((eventId: string) => void) | undefined;

  const correlationStore = {
    registerRequest: (eventId: string, request: { progressToken?: string }) => {
      registered.push({ eventId, token: request.progressToken });
    },
  } as unknown as ClientCorrelationStore;

  const deps: ClientOutboundSenderDeps = {
    serverPubkey: 's'.repeat(64),
    correlationStore,
    capabilityNegotiator:
      createCapabilityNegotiator() as ClientCapabilityNegotiator,
    oversizedEnabled: options?.oversizedEnabled ?? false,
    oversizedThreshold: Number.POSITIVE_INFINITY,
    oversizedChunkSize: 1_000,
    oversizedAcceptTimeoutMs: 1_000,
    serverSupportsOversizedTransfer: () => false,
    createRecipientTags: (pubkey) => [['p', pubkey]],
    sendMcpMessage: async (
      _msg: JSONRPCMessage,
      _pubkey: string,
      _kind: number,
      _tags?: string[][],
      _isEncrypted?: boolean,
      onEventPublished?: (eventId: string) => void,
      _wrapKind?: number,
    ): Promise<string> => {
      sequence.push('send:invoked');
      pendingPublish = onEventPublished;
      await Promise.resolve();
      sequence.push('send:publishing');
      return 'evt-id';
    },
    waitForAccept: async () => undefined,
    getOriginalRequestContext: (msg) =>
      msg && typeof msg === 'object' && 'method' in msg
        ? { method: (msg as { method: string }).method }
        : undefined,
    resolvePendingOpenStream: (token: string) => {
      sequence.push(`resolve:${token}`);
      resolvedTokens.push(token);
    },
    measurePublishedMcpMessageSize: async () => 0,
    resolveSafeOversizedChunkSize: async () => 1_000,
    logger: testLogger,
  };

  return {
    sender: new ClientOutboundSender(deps),
    sequence,
    resolvedTokens,
    registered,
    invokePublish: (eventId: string) => pendingPublish?.(eventId),
  };
}

const toolsCall = (progressToken?: string | number): JSONRPCMessage =>
  ({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'ping',
      arguments: {},
      ...(progressToken !== undefined ? { _meta: { progressToken } } : {}),
    },
  }) as JSONRPCMessage;

describe('ClientOutboundSender open-stream binding', () => {
  test('binds a tools/call progress token synchronously, before the publish callback', async () => {
    const harness = createHarness();

    await harness.sender.sendRequest(toolsCall(5));

    // resolvePendingOpenStream ran before sendMcpMessage was even invoked.
    expect(harness.sequence.slice(0, 2)).toEqual(['resolve:5', 'send:invoked']);
    expect(harness.resolvedTokens).toEqual(['5']);

    // The publish callback still registers correlation with the event id.
    harness.invokePublish('evt-id');
    expect(harness.registered).toEqual([{ eventId: 'evt-id', token: '5' }]);
  });

  test('does not bind when the tools/call carries no progress token', async () => {
    const harness = createHarness();

    await harness.sender.sendRequest(toolsCall());

    expect(harness.resolvedTokens).toEqual([]);
    expect(harness.sequence[0]).toBe('send:invoked');
  });

  test('does not bind for non-tools/call requests even with a progress token', async () => {
    const harness = createHarness();

    await harness.sender.sendRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'prompts/get',
      params: { name: 'greet', _meta: { progressToken: 7 } },
    });

    expect(harness.resolvedTokens).toEqual([]);
  });

  test('binds before the oversized path even runs (oversized streaming requests)', async () => {
    // Oversized streaming requests previously never reached the publish callback
    // (which used to hold the binding), hanging the open-stream session.
    const harness = createHarness({ oversizedEnabled: true });

    await harness.sender.sendRequest(toolsCall(9));

    expect(harness.resolvedTokens).toEqual(['9']);
    expect(harness.sequence[0]).toBe('resolve:9');
  });
});
