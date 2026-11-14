import { matchFilters, type Filter, type NostrEvent } from 'nostr-tools';
import type { RelayHandler } from '../../core/interfaces.js';

/** Publisher-visible relay failure; `accepted` says whether the relay stored the event. */
export class RelayFault extends Error {
  public constructor(public readonly accepted: boolean) {
    super(accepted ? 'Relay acknowledgement lost' : 'Relay rejected event');
    this.name = 'RelayFault';
  }
}

/** Selects events by publishing party, receiving party, and content. */
export interface FaultSelector {
  from?: string;
  to?: string;
  match?: (event: NostrEvent) => boolean;
  /** Number of events affected before the fault expires. @default 1 */
  times?: number;
}

/**
 * Publish faults: `reject` fails before acceptance; `lose_ack` stores and
 * delivers the event but fails the publisher's acknowledgement.
 * Delivery faults apply per recipient: `drop` loses one delivery, `hold`
 * defers it until released, `duplicate` delivers it twice.
 */
export type FaultAction = 'reject' | 'lose_ack' | 'drop' | 'hold' | 'duplicate';

/** Handle for one scheduled fault. */
export interface FaultHandle {
  readonly hits: number;
  /** Delivers held events in arrival order, or reversed to model reordering. */
  release(options?: { reverse?: boolean }): void;
  /** Resolves once the fault has affected `count` events. */
  hit(count?: number): Promise<void>;
}

type Rule = FaultSelector & {
  action: FaultAction;
  remaining: number;
  hits: number;
  held: Array<() => void>;
  waiters: Array<{ count: number; resolve: () => void }>;
};

type Subscription = {
  party: string;
  owner: number;
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
};

/** One relay-level observation; acceptance and recipient delivery stay distinct. */
export interface RelayRecord {
  event: NostrEvent;
  from: string;
  outcome: 'accepted' | 'rejected' | 'ack_lost';
}

/**
 * Deterministic in-memory relay with per-test fault schedules. Each test owns
 * its hub, so concurrent tests never share mutable fault state or clocks.
 */
export class FaultRelayHub {
  public readonly records: RelayRecord[] = [];
  private readonly stored: Array<{ event: NostrEvent; from: string }> = [];
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly offline = new Set<string>();
  private readonly rules: Rule[] = [];
  private readonly observers: Array<{
    selector: FaultSelector;
    resolve: (event: NostrEvent) => void;
  }> = [];
  private nextId = 1;

  /** Creates a relay handler whose publications and deliveries belong to `party`. */
  public createRelayHandler(party: string): RelayHandler {
    const owner = this.nextId++;
    return {
      connect: async (): Promise<void> => {},
      disconnect: async (): Promise<void> => this.unsubscribeOwner(owner),
      publish: async (event: NostrEvent): Promise<void> =>
        this.publish(party, event),
      subscribe: async (filters, onEvent, onEose): Promise<() => void> => {
        const id = this.nextId++;
        const subscription = { party, owner, filters, onEvent };
        this.subscriptions.set(id, subscription);
        for (const { event, from } of [...this.stored])
          if (matchFilters(filters, event))
            this.deliver(subscription, event, from);
        onEose?.();
        return (): void => {
          this.subscriptions.delete(id);
        };
      },
      unsubscribe: (): void => this.unsubscribeOwner(owner),
      getRelayUrls: (): string[] => ['memory://fault-relay'],
    };
  }

  /** Schedules a fault on matching publications or deliveries. */
  public fault(action: FaultAction, selector: FaultSelector = {}): FaultHandle {
    const rule: Rule = {
      ...selector,
      action,
      remaining: selector.times ?? 1,
      hits: 0,
      held: [],
      waiters: [],
    };
    this.rules.push(rule);
    return {
      get hits(): number {
        return rule.hits;
      },
      release: ({ reverse = false } = {}): void => {
        const held = rule.held.splice(0);
        for (const deliver of reverse ? held.reverse() : held) deliver();
      },
      hit: (count = 1): Promise<void> =>
        rule.hits >= count
          ? Promise.resolve()
          : new Promise((resolve) => rule.waiters.push({ count, resolve })),
    };
  }

  /** Resolves with the first accepted event matching `selector`, including past ones. */
  public published(selector: FaultSelector): Promise<NostrEvent> {
    const past = this.records.find(
      (record) =>
        record.outcome !== 'rejected' && this.selects(selector, record),
    );
    if (past) return Promise.resolve(past.event);
    return new Promise((resolve) => this.observers.push({ selector, resolve }));
  }

  /** Accepted events, optionally filtered by publishing party. */
  public accepted(from?: string): NostrEvent[] {
    return this.records
      .filter(
        (record) =>
          record.outcome !== 'rejected' &&
          (from === undefined || record.from === from),
      )
      .map((record) => record.event);
  }

  /** Stops live delivery to, and publication by, `party`; stored history is retained. */
  public disconnect(party: string): void {
    this.offline.add(party);
  }

  /** Restores `party` and replays stored history matching its live subscriptions. */
  public reconnect(party: string): void {
    this.offline.delete(party);
    this.replay(party, { respectSince: true });
  }

  /**
   * Re-delivers stored history to `party`, as a relay does after the recipient
   * lost its deduplication memory. By default `since` is ignored, modelling a
   * recreated transport whose new subscription would otherwise exclude it.
   */
  public replay(
    party: string,
    options: { from?: string; respectSince?: boolean } = {},
  ): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.party !== party) continue;
      const filters = options.respectSince
        ? subscription.filters
        : subscription.filters.map(({ since: _since, ...rest }) => rest);
      for (const { event, from } of [...this.stored])
        if (
          (options.from === undefined || options.from === from) &&
          matchFilters(filters, event)
        )
          this.deliver(subscription, event, from);
    }
  }

  private publish(from: string, event: NostrEvent): void {
    const rule = this.offline.has(from)
      ? undefined
      : this.take(
          (candidate) =>
            (candidate.action === 'reject' ||
              candidate.action === 'lose_ack') &&
            this.selects(candidate, { event, from }),
        );
    if (this.offline.has(from) || rule?.action === 'reject') {
      this.records.push({ event, from, outcome: 'rejected' });
      throw new RelayFault(false);
    }
    const outcome = rule?.action === 'lose_ack' ? 'ack_lost' : 'accepted';
    this.records.push({ event, from, outcome });
    this.stored.push({ event, from });
    for (const observer of this.observers.splice(0))
      if (this.selects(observer.selector, { event, from }))
        observer.resolve(event);
      else this.observers.push(observer);
    for (const subscription of [...this.subscriptions.values()])
      if (matchFilters(subscription.filters, event))
        this.deliver(subscription, event, from);
    if (rule) throw new RelayFault(true);
  }

  private deliver(
    subscription: Subscription,
    event: NostrEvent,
    from: string,
  ): void {
    if (this.offline.has(subscription.party)) return;
    const rule = this.take(
      (candidate) =>
        ['drop', 'hold', 'duplicate'].includes(candidate.action) &&
        this.selects(candidate, { event, from, to: subscription.party }),
    );
    const send = (): void => {
      if (this.subscriptions.has(this.idOf(subscription)))
        subscription.onEvent(event);
    };
    if (rule?.action === 'drop') return;
    if (rule?.action === 'hold') {
      rule.held.push(send);
      return;
    }
    send();
    if (rule?.action === 'duplicate') send();
  }

  private take(predicate: (rule: Rule) => boolean): Rule | undefined {
    const rule = this.rules.find(
      (candidate) => candidate.remaining > 0 && predicate(candidate),
    );
    if (!rule) return undefined;
    rule.remaining--;
    rule.hits++;
    for (const waiter of [...rule.waiters])
      if (rule.hits >= waiter.count) {
        rule.waiters.splice(rule.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    return rule;
  }

  private selects(
    selector: FaultSelector,
    target: { event: NostrEvent; from: string; to?: string },
  ): boolean {
    return (
      (selector.from === undefined || selector.from === target.from) &&
      (selector.to === undefined || selector.to === target.to) &&
      (selector.match === undefined || selector.match(target.event))
    );
  }

  private idOf(subscription: Subscription): number {
    for (const [id, candidate] of this.subscriptions)
      if (candidate === subscription) return id;
    return -1;
  }

  private unsubscribeOwner(owner: number): void {
    for (const [id, subscription] of this.subscriptions)
      if (subscription.owner === owner) this.subscriptions.delete(id);
  }
}

/** Parses a cleartext ContextVM message; encrypted wraps return undefined. */
export function cleartextMessage(
  event: NostrEvent,
): Record<string, unknown> | undefined {
  if (event.kind !== 25910) return undefined;
  try {
    return JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
