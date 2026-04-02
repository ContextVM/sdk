import { matchFilters } from 'nostr-tools';
import type { Filter, NostrEvent } from 'nostr-tools';
import type { RelayHandler } from '../core/interfaces.js';

type SubscriptionEntry = {
  id: number;
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
  ownerId: number;
};

/**
 * Shared in-memory relay hub for deterministic, network-free tests.
 */
export class MockRelayHub {
  private readonly relayUrls: string[];
  private readonly debug: boolean;
  private events: NostrEvent[] = [];
  private subscriptions = new Map<number, SubscriptionEntry>();
  private nextSubscriptionId = 1;
  private nextOwnerId = 1;

  public constructor(
    relayUrls: string[] = ['memory://relay'],
    options: { debug?: boolean } = {},
  ) {
    this.relayUrls = [...relayUrls];
    this.debug = options.debug ?? false;
  }

  public createRelayHandler(): MockRelayHandler {
    return new MockRelayHandler(this, this.nextOwnerId++, this.relayUrls);
  }

  public clear(): void {
    this.events = [];
    this.subscriptions.clear();
  }

  public getEvents(): NostrEvent[] {
    return [...this.events];
  }

  public publish(event: NostrEvent): void {
    this.events.push(event);
    if (this.debug) {
      console.log('[MockRelayHub] publish', {
        id: event.id,
        pubkey: event.pubkey,
        kind: event.kind,
        tags: event.tags,
        content: event.content,
      });
    }
    for (const subscription of this.subscriptions.values()) {
      if (matchFilters(subscription.filters, event)) {
        subscription.onEvent(event);
      }
    }
  }

  public subscribe(params: {
    filters: Filter[];
    onEvent: (event: NostrEvent) => void;
    onEose?: () => void;
    ownerId: number;
  }): () => void {
    const id = this.nextSubscriptionId++;
    const entry: SubscriptionEntry = {
      id,
      filters: params.filters,
      onEvent: params.onEvent,
      onEose: params.onEose,
      ownerId: params.ownerId,
    };
    this.subscriptions.set(id, entry);

    for (const event of this.events) {
      if (matchFilters(entry.filters, event)) {
        entry.onEvent(event);
      }
    }
    entry.onEose?.();

    return (): void => {
      this.subscriptions.delete(id);
    };
  }

  public unsubscribeOwner(ownerId: number): void {
    for (const [id, subscription] of this.subscriptions.entries()) {
      if (subscription.ownerId === ownerId) {
        this.subscriptions.delete(id);
      }
    }
  }
}

/**
 * In-memory relay handler implementing the relay contract without sockets.
 */
export class MockRelayHandler implements RelayHandler {
  public constructor(
    private readonly hub: MockRelayHub,
    private readonly ownerId: number,
    private readonly relayUrls: string[],
  ) {}

  public async connect(): Promise<void> {
    // no-op
  }

  public async disconnect(_relayUrls?: string[]): Promise<void> {
    this.hub.unsubscribeOwner(this.ownerId);
  }

  public async publish(
    event: NostrEvent,
    _opts?: { abortSignal?: AbortSignal },
  ): Promise<void> {
    this.hub.publish(event);
  }

  public async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): Promise<() => void> {
    return this.hub.subscribe({
      filters,
      onEvent,
      onEose,
      ownerId: this.ownerId,
    });
  }

  public unsubscribe(): void {
    this.hub.unsubscribeOwner(this.ownerId);
  }

  public getRelayUrls(): string[] {
    return [...this.relayUrls];
  }
}
