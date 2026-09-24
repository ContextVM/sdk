import { describe, expect, it } from 'bun:test';
import { SubscriptionStore } from './subscription-store.js';

describe('SubscriptionStore', () => {
  it('tracks subscriptions idempotently', () => {
    const store = new SubscriptionStore();

    store.subscribe('client-a', 'resource://alpha');
    store.subscribe('client-a', 'resource://alpha');

    expect(store.getSubscribers('resource://alpha')).toEqual(
      new Set(['client-a']),
    );
  });

  it('removes subscriptions idempotently', () => {
    const store = new SubscriptionStore();
    store.subscribe('client-a', 'resource://alpha');

    store.unsubscribe('client-a', 'resource://alpha');
    store.unsubscribe('client-a', 'resource://alpha');

    expect(store.getSubscribers('resource://alpha')).toEqual(new Set());
  });

  it('keeps unrelated subscriptions when one relationship is removed', () => {
    const store = new SubscriptionStore();
    store.subscribe('client-a', 'resource://alpha');
    store.subscribe('client-a', 'resource://beta');
    store.subscribe('client-b', 'resource://alpha');

    store.unsubscribe('client-a', 'resource://alpha');

    expect(store.getSubscribers('resource://alpha')).toEqual(
      new Set(['client-b']),
    );
    expect(store.getSubscribers('resource://beta')).toEqual(
      new Set(['client-a']),
    );
  });

  it('removes every subscription for an evicted client', () => {
    const store = new SubscriptionStore();
    store.subscribe('client-a', 'resource://alpha');
    store.subscribe('client-a', 'resource://beta');
    store.subscribe('client-b', 'resource://alpha');

    store.removeForClient('client-a');

    expect(store.getSubscribers('resource://alpha')).toEqual(
      new Set(['client-b']),
    );
    expect(store.getSubscribers('resource://beta')).toEqual(new Set());
  });

  it('clears every subscription', () => {
    const store = new SubscriptionStore();
    store.subscribe('client-a', 'resource://alpha');
    store.subscribe('client-b', 'resource://beta');

    store.clear();

    expect(store.getSubscribers('resource://alpha')).toEqual(new Set());
    expect(store.getSubscribers('resource://beta')).toEqual(new Set());
  });

  it('does not expose its mutable subscriber index', () => {
    const store = new SubscriptionStore();
    store.subscribe('client-a', 'resource://alpha');

    const subscribers = store.getSubscribers('resource://alpha');
    (subscribers as Set<string>).add('client-b');

    expect(store.getSubscribers('resource://alpha')).toEqual(
      new Set(['client-a']),
    );
  });

  it('matches only exact URIs when no sub-resource matcher is provided', () => {
    const store = new SubscriptionStore();
    store.subscribe('client-a', 'resource://repo');

    expect(store.getSubscribersForUpdate('resource://repo')).toEqual(
      new Set(['client-a']),
    );
    expect(store.getSubscribersForUpdate('resource://repo/child')).toEqual(
      new Set(),
    );
  });

  it('uses server-defined sub-resource matching and sends once per client', () => {
    const store = new SubscriptionStore();
    store.subscribe('client-a', 'resource://repo');
    store.subscribe('client-a', 'resource://repo/child');
    store.subscribe('client-b', 'resource://other');
    const matchesSubResource = (subscribedUri: string, updatedUri: string) =>
      updatedUri.startsWith(`${subscribedUri}/`);

    expect(
      store.getSubscribersForUpdate(
        'resource://repo/child',
        matchesSubResource,
      ),
    ).toEqual(new Set(['client-a']));
    expect(
      store.getSubscribersForUpdate(
        'resource://repository',
        matchesSubResource,
      ),
    ).toEqual(new Set());

    store.unsubscribe('client-a', 'resource://repo');
    store.unsubscribe('client-a', 'resource://repo/child');
    expect(
      store.getSubscribersForUpdate(
        'resource://repo/child',
        matchesSubResource,
      ),
    ).toEqual(new Set());
  });
});
