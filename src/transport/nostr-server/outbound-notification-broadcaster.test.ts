import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';
import { CorrelationStore } from './correlation-store.js';
import { OutboundNotificationBroadcaster } from './outbound-notification-broadcaster.js';
import { SessionStore } from './session-store.js';
import {
  SubscriptionStore,
  type ResourceSubscriptionMatcher,
} from './subscription-store.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

const resourceUpdated: JSONRPCMessage = {
  jsonrpc: '2.0',
  method: 'notifications/resources/updated',
  params: { uri: 'resource://alpha' },
};

function createBroadcaster(matchesSubResource?: ResourceSubscriptionMatcher): {
  broadcaster: OutboundNotificationBroadcaster;
  notifications: string[];
  tasks: Promise<void>[];
  subscriptions: SubscriptionStore;
} {
  const sessionStore = new SessionStore();
  sessionStore.getOrCreateSession('client-a', false);
  sessionStore.getOrCreateSession('client-b', false);
  sessionStore.markInitialized('client-a');
  sessionStore.markInitialized('client-b');

  const notifications: string[] = [];
  const tasks: Promise<void>[] = [];
  const subscriptions = new SubscriptionStore();
  const broadcaster = new OutboundNotificationBroadcaster({
    correlationStore: new CorrelationStore(),
    sessionStore,
    subscriptionStore: subscriptions,
    matchesSubResource,
    sendNotification: async (clientPubkey) => {
      notifications.push(clientPubkey);
    },
    enqueueTask: (task) => {
      tasks.push(task());
    },
    logger: testLogger,
  });

  return { broadcaster, notifications, tasks, subscriptions };
}

describe('OutboundNotificationBroadcaster', () => {
  test('routes resource updates only to subscribers', async () => {
    const { broadcaster, notifications, tasks, subscriptions } =
      createBroadcaster();
    subscriptions.subscribe('client-a', 'resource://alpha');

    await broadcaster.broadcast(resourceUpdated);
    await Promise.all(tasks);

    expect(notifications).toEqual(['client-a']);
  });

  test('does not broadcast resource updates for an unknown URI', async () => {
    const { broadcaster, notifications, tasks } = createBroadcaster();

    await broadcaster.broadcast(resourceUpdated);
    await Promise.all(tasks);

    expect(notifications).toEqual([]);
  });

  test('routes a resource update to every subscriber, and only those subscribers', async () => {
    const { broadcaster, notifications, tasks, subscriptions } =
      createBroadcaster();
    subscriptions.subscribe('client-a', 'resource://alpha');
    subscriptions.subscribe('client-b', 'resource://alpha');

    await broadcaster.broadcast(resourceUpdated);
    await Promise.all(tasks);

    expect(notifications).toEqual(['client-a', 'client-b']);
  });

  test('sends one update when a client matches both parent and exact subscriptions', async () => {
    const { broadcaster, notifications, tasks, subscriptions } =
      createBroadcaster((subscribedUri, updatedUri) =>
        updatedUri.startsWith(`${subscribedUri}/`),
      );
    subscriptions.subscribe('client-a', 'resource://repo');
    subscriptions.subscribe('client-a', 'resource://repo/child');
    subscriptions.subscribe('client-b', 'resource://other');

    await broadcaster.broadcast({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'resource://repo/child' },
    });
    await Promise.all(tasks);

    expect(notifications).toEqual(['client-a']);
  });

  test('does not fall back to generic broadcast when a resource URI is missing', async () => {
    const { broadcaster, notifications, tasks, subscriptions } =
      createBroadcaster();
    subscriptions.subscribe('client-a', 'resource://alpha');

    await broadcaster.broadcast({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
    });
    await Promise.all(tasks);

    expect(notifications).toEqual([]);
  });

  test('continues to broadcast unrelated notifications to initialized sessions', async () => {
    const { broadcaster, notifications, tasks } = createBroadcaster();

    await broadcaster.broadcast({
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    });
    await Promise.all(tasks);

    expect(notifications).toEqual(['client-a', 'client-b']);
  });
});
