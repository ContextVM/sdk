import { describe, expect, test } from 'bun:test';
import type { JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import { isJSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import type { NostrEvent } from 'nostr-tools';
import type { Logger } from '../../core/utils/logger.js';
import { GiftWrapMode } from '../../core/interfaces.js';
import { sleep } from '../../core/utils/utils.js';
import type { InboundMiddlewareFn } from '../middleware.js';
import { AuthorizationPolicy } from './authorization-policy.js';
import { CorrelationStore } from './correlation-store.js';
import {
  ServerInboundCoordinator,
  type ServerInboundCoordinatorDeps,
} from './inbound-coordinator.js';
import type { ServerOpenStreamFactory } from './open-stream-factory.js';
import { SessionStore } from './session-store.js';
import { SubscriptionStore } from './subscription-store.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

const clientPubkey = 'client-pk';
const resourceUri = 'resource://alpha';

function requestEvent(id: string, pubkey = clientPubkey): NostrEvent {
  return {
    id,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: '',
    sig: 'c'.repeat(128),
  } as NostrEvent;
}

function subscriptionRequest(
  id: string,
  method: string,
  uri: string,
): JSONRPCRequest {
  return { jsonrpc: '2.0', id, method, params: { uri } };
}

function createCoordinator(options?: {
  authorizationPolicy?: AuthorizationPolicy;
  inboundMiddlewares?: InboundMiddlewareFn[];
}): {
  coordinator: ServerInboundCoordinator;
  subscriptions: SubscriptionStore;
  correlationStore: CorrelationStore;
} {
  const sessionStore = new SessionStore();
  const correlationStore = new CorrelationStore();
  const subscriptions = new SubscriptionStore();
  const deps: ServerInboundCoordinatorDeps = {
    sessionStore,
    correlationStore,
    subscriptionStore: subscriptions,
    authorizationPolicy:
      options?.authorizationPolicy ?? new AuthorizationPolicy(),
    openStreamFactory: {
      createWriterIfEnabled: () => undefined,
      inputStreamIfEnabled: () => undefined,
      releaseUnusedWriter: () => undefined,
    } as unknown as ServerOpenStreamFactory,
    inboundMiddlewares: options?.inboundMiddlewares ?? [],
    injectClientPubkey: false,
    shouldInjectRequestEventId: false,
    oversizedEnabled: false,
    openStreamEnabled: false,
    giftWrapMode: GiftWrapMode.OPTIONAL,
    sendMcpMessage: async () => 'event-id',
    createResponseTags: () => [],
    getOrCreateClientSession: (pk, isEncrypted) =>
      sessionStore.getOrCreateSession(pk, isEncrypted)[0],
    forwardMessage: async () => true,
    logger: testLogger,
  };
  return {
    coordinator: new ServerInboundCoordinator(deps),
    subscriptions,
    correlationStore,
  };
}

describe('ServerInboundCoordinator resource subscriptions', () => {
  test('records a subscription when subscribe is forwarded and removes it when unsubscribe is forwarded', async () => {
    const { coordinator, subscriptions } = createCoordinator();

    await coordinator.authorizeAndProcessEvent(
      requestEvent('a'.repeat(64)),
      false,
      subscriptionRequest('req-1', 'resources/subscribe', resourceUri),
    );
    await sleep(0);

    expect(subscriptions.getSubscribers(resourceUri)).toEqual(
      new Set([clientPubkey]),
    );

    await coordinator.authorizeAndProcessEvent(
      requestEvent('b'.repeat(64)),
      false,
      subscriptionRequest('req-2', 'resources/unsubscribe', resourceUri),
    );
    await sleep(0);

    expect(subscriptions.getSubscribers(resourceUri)).toEqual(new Set());
  });

  test('does not record a subscription when a middleware drops the request', async () => {
    const dropAll: InboundMiddlewareFn = async () => undefined;
    const { coordinator, subscriptions, correlationStore } = createCoordinator({
      inboundMiddlewares: [dropAll],
    });

    await coordinator.authorizeAndProcessEvent(
      requestEvent('a'.repeat(64)),
      false,
      subscriptionRequest('req-1', 'resources/subscribe', resourceUri),
    );
    await sleep(0);

    expect(subscriptions.getSubscribers(resourceUri)).toEqual(new Set());
    expect(correlationStore.getEventRoute('a'.repeat(64))).toBeUndefined();
  });

  test('keeps an existing subscription when a dropped unsubscribe never reaches the server', async () => {
    const dropUnsubscribe: InboundMiddlewareFn = async (
      message,
      _ctx,
      forward,
    ) => {
      if (
        isJSONRPCRequest(message) &&
        message.method === 'resources/unsubscribe'
      ) {
        return;
      }
      await forward(message);
    };
    const { coordinator, subscriptions } = createCoordinator({
      inboundMiddlewares: [dropUnsubscribe],
    });

    await coordinator.authorizeAndProcessEvent(
      requestEvent('a'.repeat(64)),
      false,
      subscriptionRequest('req-1', 'resources/subscribe', resourceUri),
    );
    await sleep(0);
    await coordinator.authorizeAndProcessEvent(
      requestEvent('b'.repeat(64)),
      false,
      subscriptionRequest('req-2', 'resources/unsubscribe', resourceUri),
    );
    await sleep(0);

    expect(subscriptions.getSubscribers(resourceUri)).toEqual(
      new Set([clientPubkey]),
    );
  });

  test("clears a client's subscriptions when authorization rejects it", async () => {
    const { coordinator, subscriptions } = createCoordinator({
      authorizationPolicy: new AuthorizationPolicy({
        allowedPublicKeys: new Set(['other-pk']),
      }),
    });
    subscriptions.subscribe(clientPubkey, resourceUri);

    await coordinator.authorizeAndProcessEvent(
      requestEvent('a'.repeat(64)),
      false,
      subscriptionRequest('req-1', 'resources/read', resourceUri),
    );
    await sleep(0);

    expect(subscriptions.getSubscribers(resourceUri)).toEqual(new Set());
  });
});
