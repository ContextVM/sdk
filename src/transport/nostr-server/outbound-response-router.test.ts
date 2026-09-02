import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
} from '@contextvm/mcp-sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';
import type { NostrEvent } from 'nostr-tools';
import { EPHEMERAL_GIFT_WRAP_KIND } from '../../core/constants.js';
import {
  OutboundResponseRouter,
  type OutboundResponseRouterDeps,
} from './outbound-response-router.js';
import { CorrelationStore } from './correlation-store.js';
import type { ClientSession } from './session-store.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

const CLIENT_PUBKEY = 'a'.repeat(64);

function createSession(overrides: Partial<ClientSession> = {}): ClientSession {
  return {
    isInitialized: true,
    isEncrypted: true,
    hasSentCommonTags: true,
    supportsEncryption: true,
    // Divergence precondition: no ephemeral capability learned from the client,
    // so the fallback wrap kind is what chooseGiftWrapKind settles on.
    supportsEphemeralEncryption: false,
    supportsOversizedTransfer: false,
    supportsOpenStream: false,
    ...overrides,
  };
}

interface CapturedDeps {
  deps: OutboundResponseRouterDeps;
  chooseCalls: Array<{ fallbackWrapKind?: number }>;
  sentGiftWrapKinds: Array<number | undefined>;
  sentMessages: JSONRPCMessage[];
}

function createRouterWithCapturedDeps(
  correlationStore: CorrelationStore,
  session: ClientSession,
  options: { failSend?: boolean } = {},
): CapturedDeps {
  const chooseCalls: CapturedDeps['chooseCalls'] = [];
  const sentGiftWrapKinds: CapturedDeps['sentGiftWrapKinds'] = [];
  const sentMessages: CapturedDeps['sentMessages'] = [];

  const deps = {
    correlationStore,
    sessionStore: {
      getSession: (pubkey: string) =>
        pubkey === CLIENT_PUBKEY ? session : undefined,
    },
    announcementManager: { getPricingTags: () => [] as string[][] },
    openStreamFactory: {
      deferIfStreamActive: () => false,
      takePendingEviction: () => undefined,
    },
    oversizedConfig: { enabled: false, threshold: 0, chunkSize: 0 },
    applyListToolsResultTransformers: (result: unknown) => result,
    buildOutboundTags: (params: { baseTags: readonly string[][] }) => [
      ...params.baseTags,
    ],
    createResponseTags: () => [] as string[][],
    chooseGiftWrapKind: (params: { fallbackWrapKind?: number }) => {
      chooseCalls.push({ fallbackWrapKind: params.fallbackWrapKind });
      return params.fallbackWrapKind;
    },
    sendMcpMessage: async (
      _message: JSONRPCMessage,
      _targetPubkey: string,
      _kind: number,
      _tags?: string[][],
      _encrypt?: boolean,
      _onCreateEvent?: (eventId: string) => void,
      giftWrapKind?: number,
    ) => {
      if (options.failSend) {
        throw new Error('send failed');
      }
      sentMessages.push(_message);
      sentGiftWrapKinds.push(giftWrapKind);
      return 'inner-event-id';
    },
    measurePublishedMcpMessageSize: async () => 0,
    resolveSafeOversizedChunkSize: async () => 0,
    logger: testLogger,
  } as unknown as OutboundResponseRouterDeps;

  return { deps, chooseCalls, sentGiftWrapKinds, sentMessages };
}

const gatingErrorResponse: JSONRPCErrorResponse = {
  jsonrpc: '2.0',
  id: 'original-request-id',
  error: { code: -32042, message: 'Payment Required' },
};

describe('OutboundResponseRouter.routeTargeted', () => {
  test('mirrors the wrap kind recorded for the request event', async () => {
    const correlationStore = new CorrelationStore({});
    correlationStore.registerEventRoute(
      'evt-ephemeral',
      CLIENT_PUBKEY,
      'original-request-id',
      undefined,
      EPHEMERAL_GIFT_WRAP_KIND,
    );
    const { deps, chooseCalls, sentGiftWrapKinds } =
      createRouterWithCapturedDeps(correlationStore, createSession());

    await new OutboundResponseRouter(deps).routeTargeted(
      CLIENT_PUBKEY,
      gatingErrorResponse,
      'evt-ephemeral',
    );

    expect(chooseCalls).toEqual([
      { fallbackWrapKind: EPHEMERAL_GIFT_WRAP_KIND },
    ]);
    expect(sentGiftWrapKinds).toEqual([EPHEMERAL_GIFT_WRAP_KIND]);
    // Non-destructive: the early rejection must not consume the route, which
    // the normal response/cleanup lifecycle still needs.
    expect(correlationStore.hasEventRoute('evt-ephemeral')).toBe(true);
  });

  test('sends without a wrap-kind hint when no route is recorded', async () => {
    const { deps, chooseCalls, sentGiftWrapKinds } =
      createRouterWithCapturedDeps(new CorrelationStore({}), createSession());

    await new OutboundResponseRouter(deps).routeTargeted(
      CLIENT_PUBKEY,
      gatingErrorResponse,
      'evt-unknown',
    );

    expect(chooseCalls).toEqual([{ fallbackWrapKind: undefined }]);
    expect(sentGiftWrapKinds).toEqual([undefined]);
  });

  test('restores the client request id the coordinator rewrote to the event id', async () => {
    const correlationStore = new CorrelationStore({});
    correlationStore.registerEventRoute(
      'evt-rewritten',
      CLIENT_PUBKEY,
      42,
      undefined,
      EPHEMERAL_GIFT_WRAP_KIND,
    );
    const { deps, sentMessages } = createRouterWithCapturedDeps(
      correlationStore,
      createSession(),
    );

    // The gating middleware echoes the id it saw: the event id, post-rewrite.
    const errorWithEventId: JSONRPCErrorResponse = {
      ...gatingErrorResponse,
      id: 'evt-rewritten',
    };
    await new OutboundResponseRouter(deps).routeTargeted(
      CLIENT_PUBKEY,
      errorWithEventId,
      'evt-rewritten',
    );

    // On the wire: the caller's original JSON-RPC id, not the routing key.
    expect((sentMessages[0] as JSONRPCErrorResponse).id).toBe(42);
    // Non-mutating: the caller's response object is untouched.
    expect(errorWithEventId.id).toBe('evt-rewritten');
  });

  test('keeps the response id as-is when no route is recorded', async () => {
    const { deps, sentMessages } = createRouterWithCapturedDeps(
      new CorrelationStore({}),
      createSession(),
    );

    await new OutboundResponseRouter(deps).routeTargeted(
      CLIENT_PUBKEY,
      { ...gatingErrorResponse, id: 'evt-unknown' },
      'evt-unknown',
    );

    expect((sentMessages[0] as JSONRPCErrorResponse).id).toBe('evt-unknown');
  });

  test('does not send when the client has no active session', async () => {
    const { deps, chooseCalls, sentGiftWrapKinds } =
      createRouterWithCapturedDeps(new CorrelationStore({}), createSession());

    await new OutboundResponseRouter(deps).routeTargeted(
      'b'.repeat(64),
      gatingErrorResponse,
      'evt-any',
    );

    expect(chooseCalls).toHaveLength(0);
    expect(sentGiftWrapKinds).toHaveLength(0);
  });

  test('re-registers the route with its request event when the send fails', async () => {
    const requestEvent = {
      id: 'evt-a3',
      pubkey: CLIENT_PUBKEY,
      sig: 'sig',
      kind: 15,
      tags: [],
      content: '{}',
      created_at: 0,
    } as NostrEvent;
    const correlationStore = new CorrelationStore({});
    correlationStore.registerEventRoute(
      'evt-a3',
      CLIENT_PUBKEY,
      'original-request-id',
      undefined,
      EPHEMERAL_GIFT_WRAP_KIND,
      requestEvent,
    );
    const { deps } = createRouterWithCapturedDeps(
      correlationStore,
      createSession(),
      { failSend: true },
    );

    await expect(
      new OutboundResponseRouter(deps).route({
        jsonrpc: '2.0',
        id: 'evt-a3',
        result: {},
      }),
    ).rejects.toThrow('send failed');

    // The retry path must restore the full route, including the signed
    // request event exposed via getNostrRequestEvent().
    const restored = correlationStore.getEventRoute('evt-a3');
    expect(restored?.wrapKind).toBe(EPHEMERAL_GIFT_WRAP_KIND);
    expect(correlationStore.getRequestEvent('evt-a3')).toBe(requestEvent);
  });
});

describe('OutboundResponseRouter.route payment route snapshot fallback', () => {
  // Fresh object per test: route() restores the original request id by
  // mutating the response in place, so a shared literal would leak state.
  const paidResult = () => ({
    jsonrpc: '2.0' as const,
    id: 'evt-paid',
    result: { content: [] },
  });

  test('delivers from the snapshot when the live route was popped by duplicate-delivery cleanup', async () => {
    const correlationStore = new CorrelationStore({});
    correlationStore.registerEventRoute(
      'evt-paid',
      CLIENT_PUBKEY,
      'original-request-id',
      undefined,
      EPHEMERAL_GIFT_WRAP_KIND,
    );
    const session = createSession();
    correlationStore.captureRouteSnapshot('evt-paid', session, 60_000);
    // Duplicate delivery popped the route while payment settled.
    correlationStore.popEventRoute('evt-paid');

    const { deps, sentGiftWrapKinds } = createRouterWithCapturedDeps(
      correlationStore,
      session,
    );
    const sent: JSONRPCMessage[] = [];
    (
      deps as { sendMcpMessage: OutboundResponseRouterDeps['sendMcpMessage'] }
    ).sendMcpMessage = async (
      message,
      _target,
      _kind,
      _tags,
      _encrypt,
      _onCreate,
      giftWrapKind,
    ) => {
      sent.push(message);
      sentGiftWrapKinds.push(giftWrapKind);
      return 'inner-event-id';
    };

    await new OutboundResponseRouter(deps).route(paidResult());

    expect(sent).toHaveLength(1);
    // The client sees the result under its original request id.
    expect((sent[0] as { id?: string }).id).toBe('original-request-id');
    expect(sentGiftWrapKinds).toEqual([EPHEMERAL_GIFT_WRAP_KIND]);
  });

  test('delivers from the snapshot session when the paying client was evicted', async () => {
    const correlationStore = new CorrelationStore({});
    correlationStore.registerEventRoute(
      'evt-paid',
      CLIENT_PUBKEY,
      'original-request-id',
    );
    correlationStore.captureRouteSnapshot(
      'evt-paid',
      createSession({ isEncrypted: false }),
      60_000,
    );
    // Session eviction removed the route entirely.
    correlationStore.removeRoutesForClient(CLIENT_PUBKEY);

    const { deps } = createRouterWithCapturedDeps(
      correlationStore,
      createSession(),
    );
    // The live session store no longer knows the client.
    (deps.sessionStore as { getSession: (p: string) => unknown }).getSession =
      () => undefined;

    const sent: JSONRPCMessage[] = [];
    (
      deps as { sendMcpMessage: OutboundResponseRouterDeps['sendMcpMessage'] }
    ).sendMcpMessage = async (message) => {
      sent.push(message);
      return 'inner-event-id';
    };

    await new OutboundResponseRouter(deps).route(paidResult());

    expect(sent).toHaveLength(1);
    expect((sent[0] as { id?: string }).id).toBe('original-request-id');
  });

  test('still errors when neither route nor snapshot exists', async () => {
    const { deps } = createRouterWithCapturedDeps(
      new CorrelationStore({}),
      createSession(),
    );
    const errors: Error[] = [];
    deps.onerror = (e) => errors.push(e);

    await new OutboundResponseRouter(deps).route(paidResult());

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('No pending request found');
  });
});
