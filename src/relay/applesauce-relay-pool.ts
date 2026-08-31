import {
  Relay,
  RelayGroup,
  type PublishOptions,
  type RelayOptions,
} from 'applesauce-relay';
import type { NostrEvent, Filter } from 'nostr-tools';
import { RelayHandler } from '../core/interfaces.js';
import { createLogger } from '../core/utils/logger.js';
import { sleep } from '../core/utils/utils.js';
import { ensureWebSocket } from '../core/utils/websocket.js';
import {
  lastValueFrom,
  Subscription,
  takeUntil,
  timer,
  timeout,
  type Observable,
  Subject,
  filter,
  take,
} from 'rxjs';

const logger = createLogger('applesauce-relay');
const RELAY_REJECTED_PUBLISH_ERROR = 'Relay rejected publish';

/** Dummy filter that returns no results, used for liveness ping */
export const PING_FILTER: Filter = {
  ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  limit: 0,
};

/** Subscription intent stored for replay after rebuild */
type SubscriptionDescriptor = {
  id: string;
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
};

type SubscriptionState = SubscriptionDescriptor & {
  /** Runtime unsubscribe handle for the currently active RxJS subscription (if started). */
  unsubscribe?: () => void;
};

/** Configuration options for ApplesauceRelayPool */
export interface ApplesauceRelayPoolOptions {
  pingFrequencyMs?: number;
  /** Ping timeout in ms (default: 20000) */
  pingTimeoutMs?: number;
  /** Reconnect backoff base delay in ms (default: 3000) */
  reconnectBaseDelayMs?: number;
  /** Reconnect backoff max delay in ms (default: 30000) */
  reconnectMaxDelayMs?: number;
  /** Options passed through to each underlying applesauce Relay instance. */
  relayOptions?: Omit<
    RelayOptions,
    'keepAlive' | 'enablePing' | 'pingFrequency' | 'pingTimeout'
  >;
  /** Per-attempt publish options passed to RelayGroup.publish(). */
  publishOptions?: Pick<PublishOptions, 'timeout' | 'retries'>;
}

/**
 * RelayHandler implementation backed by applesauce-relay.
 */
export class ApplesauceRelayPool implements RelayHandler {
  private readonly relayUrls: string[];
  private relayGroup: RelayGroup;
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private relayGeneration = 0;
  /** Aborted by {@link disconnect}: the pool's infinite publish retry loop is
   * cancelled by its own teardown, not left spinning on dead sockets. */
  private readonly lifecycle = new AbortController();

  // Outbound publish policy
  private static readonly DEFAULT_PUBLISH_ATTEMPT_TIMEOUT_MS = 10_000;
  private static readonly DEFAULT_PUBLISH_ATTEMPT_RETRIES = 1;
  private static readonly PUBLISH_RETRY_INTERVAL_MS = 500;
  private static readonly PUBLISH_ERROR_LOG_INTERVAL_MS = 10_000;

  // Reconnect backoff policy (instance-configurable)
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  // Liveness ping policy (instance-configurable)
  private readonly pingFrequencyMs: number;
  private readonly pingTimeoutMs: number;
  private readonly relayOptions?: ApplesauceRelayPoolOptions['relayOptions'];
  private readonly publishOptions: Pick<PublishOptions, 'timeout' | 'retries'>;

  private static readonly DISCONNECT_CLOSE_TIMEOUT_MS = 2_000;

  // Liveness tracking
  private pingSubscription?: Subscription;
  private readonly destroy$ = new Subject<void>();
  private rebuildInFlight?: Promise<void>;
  /** Tracks last known connection status per relay URL purely to deduplicate "Relay came online" log lines */
  private relayStates = new Map<string, boolean>();
  private relayObservers: Subscription[] = [];
  private relays: Relay[] = [];

  /**
   * Terminates a relay for discard. `Relay.close()` (applesauce-relay >= 6.2.1)
   * is terminal: it cancels the reconnect timer, tears down internal watchers,
   * and completes the watchTower source (`_ready$`).
   */
  private discardRelay(relay: Relay): void {
    try {
      relay.close();
    } catch (error) {
      logger.warn('Error during relay close', {
        url: relay.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createRelay(url: string): Relay {
    ensureWebSocket();

    // NOTE: applesauce-relay uses `keepAlive` as the delay before tearing down the
    // websocket after the last subscription is unsubscribed.
    //
    // We set it to slightly larger than our liveness
    // cadence so that short gaps don't cause unnecessary disconnect/reconnect.
    const relay = new Relay(url, {
      ...this.relayOptions,
      keepAlive: this.pingFrequencyMs + this.pingTimeoutMs + 5_000,
    });

    // Ensure reconnect attempts continue at a bounded cadence even after many
    // failures, so a relay coming back online is picked up quickly.
    relay.reconnectTimer = (
      _error: Error | CloseEvent,
      tries = 0,
    ): Observable<number> => {
      const delay = Math.min(
        Math.pow(1.5, tries) * this.reconnectBaseDelayMs,
        this.reconnectMaxDelayMs,
      );
      return timer(delay);
    };

    // Observability for connection state monitoring (tracked for cleanup on rebuild)
    const connectedSub = relay.connected$.subscribe((connected) => {
      logger.debug('Connection status changed', {
        relayUrl: relay.url,
        connected,
      });

      if (connected) {
        const wasConnected = this.relayStates.get(relay.url) ?? false;
        if (!wasConnected) {
          logger.info('Relay came online', { relayUrl: relay.url });
          this.relayStates.set(relay.url, true);
        }
      } else {
        this.relayStates.set(relay.url, false);
      }
    });

    const errorSub = relay.error$.subscribe((error) => {
      if (!error) return;
      logger.error('Relay connection error', {
        relayUrl: relay.url,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.relayObservers.push(connectedSub, errorSub);

    return relay;
  }

  /**
   * Creates a new ApplesauceRelayPool instance.
   * @param relayUrls - An array of relay URLs to connect to.
   * @param opts - Optional configuration for ping behavior.
   */
  constructor(relayUrls: string[], opts?: ApplesauceRelayPoolOptions) {
    this.relayUrls = relayUrls;
    this.pingFrequencyMs = opts?.pingFrequencyMs ?? 120_000;
    this.pingTimeoutMs = opts?.pingTimeoutMs ?? 20_000;
    this.reconnectBaseDelayMs = opts?.reconnectBaseDelayMs ?? 3_000;
    this.reconnectMaxDelayMs = opts?.reconnectMaxDelayMs ?? 30_000;
    this.relayOptions = opts?.relayOptions;
    this.publishOptions = {
      timeout:
        opts?.publishOptions?.timeout ??
        ApplesauceRelayPool.DEFAULT_PUBLISH_ATTEMPT_TIMEOUT_MS,
      retries:
        opts?.publishOptions?.retries ??
        ApplesauceRelayPool.DEFAULT_PUBLISH_ATTEMPT_RETRIES,
    };

    this.relays = relayUrls.map((url) => this.createRelay(url));
    this.relayGroup = new RelayGroup(this.relays);
  }

  /**
   * Connects to the configured relays.
   * Validates relay URLs and initializes the relay group.
   */
  async connect(): Promise<void> {
    logger.debug('Connecting to relays', { relayUrls: this.relayUrls });

    for (const url of this.relayUrls) {
      try {
        new URL(url);
      } catch (error) {
        logger.error('Invalid relay URL', { url, error });
        throw new Error(`Invalid relay URL: ${url}`);
      }
    }

    logger.debug('Relay group initialized', { relayUrls: this.relayUrls });
  }

  /**
   * Publishes a Nostr event to the relay group.
   * @param event - The Nostr event to publish.
   */
  async publish(
    event: NostrEvent,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<void> {
    logger.debug('Publishing event', { eventId: event.id, kind: event.kind });

    // NOTE: Publishing is intentionally retried indefinitely.
    // MCP JSON-RPC round-trips cannot complete without delivering responses.
    let lastLogAt = 0;
    let attempt = 0;

    while (true) {
      if (opts?.abortSignal?.aborted || this.lifecycle.signal.aborted) {
        throw new Error('Publish aborted');
      }
      attempt += 1;
      const publishGeneration = this.relayGeneration;
      try {
        const responses = await this.relayGroup.publish(
          event,
          this.publishOptions,
        );

        const connectedRelayUrls = new Set(
          this.relays
            .filter((relay) => relay.connected)
            .map((relay) => relay.url),
        );
        let acceptedCount = 0;
        let connectedFailureCount = 0;
        for (const response of responses) {
          if (response.ok) {
            acceptedCount += 1;
          } else if (
            response.from !== undefined &&
            connectedRelayUrls.has(response.from) &&
            !response.message?.includes('object unsubscribed') &&
            !response.message?.toLowerCase().includes('timeout') &&
            !response.message?.includes('Connection error')
          ) {
            connectedFailureCount += 1;
          }
        }

        logger.debug('Publish attempt completed', {
          eventId: event.id,
          kind: event.kind,
          attempt,
          responseCount: responses.length,
          acceptedCount,
          connectedFailureCount,
          connectedRelayUrls: Array.from(connectedRelayUrls),
          responses,
        });

        const rebuildDisruptedAttempt =
          publishGeneration !== this.relayGeneration ||
          this.rebuildInFlight !== undefined;

        if (
          acceptedCount === 0 &&
          responses.length === 0 &&
          rebuildDisruptedAttempt
        ) {
          logger.warn(
            'Publish acknowledgement ambiguous during relay rebuild',
            {
              eventId: event.id,
              kind: event.kind,
              attempt,
              publishGeneration,
              currentGeneration: this.relayGeneration,
            },
          );

          if (this.rebuildInFlight) {
            await this.rebuildInFlight.catch(() => undefined);
          }

          await sleep(ApplesauceRelayPool.PUBLISH_RETRY_INTERVAL_MS);
          continue;
        }

        if (responses.length > 0) {
          if (acceptedCount > 0) {
            logger.debug('Event published successfully', {
              eventId: event.id,
              acceptedCount,
              connectedFailureCount,
            });
            return;
          }

          if (connectedFailureCount > 0) {
            throw new Error(RELAY_REJECTED_PUBLISH_ERROR);
          }
        }

        throw new Error(
          `Failed to publish event. Responses: ${JSON.stringify(responses)}`,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === RELAY_REJECTED_PUBLISH_ERROR
        ) {
          throw error;
        }

        const now = Date.now();
        if (
          now - lastLogAt >=
          ApplesauceRelayPool.PUBLISH_ERROR_LOG_INTERVAL_MS
        ) {
          lastLogAt = now;
          logger.error('Publish failed; will retry', {
            eventId: event.id,
            kind: event.kind,
            attempt,
            error,
          });
        }

        await sleep(ApplesauceRelayPool.PUBLISH_RETRY_INTERVAL_MS);
      }
    }
  }

  /**
   * Creates a subscription wrapper around the RelayGroup's subscription method.
   * @param filters - Array of filters to subscribe to.
   * @param onEvent - Callback function for received events.
   * @param onEose - Optional callback function for end-of-stream events.
   * @returns Object with unsubscribe method.
   */
  private createSubscription(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): () => void {
    logger.debug('Creating subscription', { filters });

    // Dedup is intentionally NOT performed at the relay layer:
    //   - The transport layer already deduplicates gift-wrap envelopes and
    //     decrypted inner events via its own `seenEventIds` cache, with
    //     protocol-aware semantics.
    //   - The explicit-gating payment flow republishes the SAME request event
    //     id after payment and relies on the server re-observing it. Relay-
    //     layer dedup by event id silently swallows that retry and deadlocks
    //     the flow.
    //
    const stream = onEose
      ? this.relayGroup.req(filters)
      : this.relayGroup.subscription(filters, {
          reconnect: Infinity,
          resubscribe: Infinity,
          eventStore: null, // intentionally disable relay-layer dedup
        });

    const sub = (stream as Observable<unknown>).subscribe({
      next: (message: unknown) => {
        logger.debug('Received raw message', { message });
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message
        ) {
          const msg = message as { type: string; event?: NostrEvent };
          if (msg.type === 'EOSE') onEose?.();
          else if (msg.type === 'EVENT' && msg.event) onEvent(msg.event);
          return;
        }

        if (Array.isArray(message)) {
          if (message[0] === 'EOSE') onEose?.();
          else if (message[0] === 'EVENT' && message[2])
            onEvent(message[2] as NostrEvent);
          return;
        }

        if (message === 'EOSE') onEose?.();
        else if (
          typeof message === 'object' &&
          message !== null &&
          'id' in message
        )
          onEvent(message as NostrEvent);
      },
      error: (error: unknown) => {
        logger.warn('Subscription error', { filters, error });
      },
      complete: () => {
        logger.debug('Subscription complete');
      },
    });

    return () => sub.unsubscribe();
  }

  /**
   * Subscribes to events from the relay group.
   * @param filters - Array of filters to subscribe to.
   * @param onEvent - Callback function for received events.
   * @param onEose - Optional callback function for end-of-stream events.
   */
  async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): Promise<() => void> {
    const id = `sub:${Date.now()}:${Math.random().toString(16).slice(2)}`;

    const state: SubscriptionState = { id, filters, onEvent, onEose };
    state.unsubscribe = this.createSubscription(filters, onEvent, onEose);
    this.subscriptions.set(id, state);

    // Start ping monitor lazily on first subscription
    logger.debug('Starting ping monitor from subscribe', {
      activeSubscriptions: this.subscriptions.size,
    });
    this.startPingMonitor();

    // Return a per-subscription unsubscribe that also cleans up replay intent.
    return (): void => {
      try {
        this.subscriptions.get(id)?.unsubscribe?.();
      } finally {
        this.subscriptions.delete(id);

        // If nothing is subscribed, stop pinging (otherwise liveness can
        // incorrectly rebuild a perfectly healthy-but-idle pool).
        if (this.subscriptions.size === 0) {
          this.stopPingMonitor();
        }
      }
    };
  }

  private isDisconnected = false;

  /**
   * Disconnects from all relays and cleans up resources.
   */
  async disconnect(): Promise<void> {
    this.isDisconnected = true;
    // Cancel in-flight publishes first: their infinite retry loop must not
    // outlive the pool (each iteration fails instantly on closed sockets and
    // would otherwise spin forever).
    this.lifecycle.abort();
    this.destroy$.next();
    this.destroy$.complete();

    // If a rebuild is in flight, await it (bounded) so we don't leave timers/subscriptions
    // created during rebuild alive past disconnect.
    if (this.rebuildInFlight) {
      await Promise.race([
        this.rebuildInFlight.catch(() => undefined),
        sleep(ApplesauceRelayPool.DISCONNECT_CLOSE_TIMEOUT_MS),
      ]);
    }
    this.unsubscribe();

    // Clean up relay observers
    for (const sub of this.relayObservers) sub.unsubscribe();
    this.relayObservers = [];

    // Terminal teardown of each relay (see discardRelay).
    for (const relay of this.relays) {
      this.discardRelay(relay);
    }
    this.relays = [];
    this.relayGroup = new RelayGroup([]);

    logger.debug('Disconnected from all relays');
  }

  /**
   * Stops all active subscriptions without clearing subscription descriptors.
   * Used internally during rebuild to preserve subscription intent for replay.
   */
  private stopActiveSubscriptions(): void {
    logger.debug('Stopping active subscriptions (preserving descriptors)');

    try {
      for (const sub of this.subscriptions.values()) {
        sub.unsubscribe?.();
        sub.unsubscribe = undefined;
      }
    } catch (error) {
      logger.error('Error while stopping active subscriptions', { error });
    }
  }

  /**
   * Unsubscribes from all active subscriptions and clears subscription descriptors.
   */
  unsubscribe(): void {
    logger.debug('Unsubscribing from all subscriptions');

    try {
      for (const sub of this.subscriptions.values()) {
        sub.unsubscribe?.();
      }
      this.subscriptions.clear();
      // If nothing is subscribed, stop pinging (otherwise liveness can
      // incorrectly rebuild a perfectly healthy-but-idle pool).
      this.stopPingMonitor();
    } catch (error) {
      logger.error('Error while unsubscribing from subscriptions', { error });
    }
  }

  /**
   * Returns the list of relay URLs configured for this relay pool.
   * @returns An array of relay URLs.
   */
  getRelayUrls(): string[] {
    return [...this.relayUrls];
  }

  /** Stops the liveness ping monitor */
  private stopPingMonitor(): void {
    if (this.pingSubscription) {
      this.pingSubscription.unsubscribe();
      this.pingSubscription = undefined;
    }
  }

  /** Starts the liveness ping monitor (called lazily on first subscribe) */
  private startPingMonitor(): void {
    if (this.pingSubscription || this.isDisconnected) {
      logger.debug(
        'Ping monitor already started or pool disconnected, skipping',
      );
      return;
    }

    // Add jitter to prevent thundering herd: ±5 seconds (but ensure it's reasonable for small intervals)
    const jitter =
      Math.random() * Math.min(10_000, this.pingFrequencyMs) -
      Math.min(5_000, this.pingFrequencyMs / 2);
    const initialDelay = Math.max(0, this.pingFrequencyMs + jitter);

    this.pingSubscription = timer(initialDelay, this.pingFrequencyMs)
      .pipe(
        // Stop on destroy
        takeUntil(this.destroy$),
      )
      .subscribe({
        next: () => {
          void this.checkLiveness();
        },
        error: (err) => {
          logger.error('Ping monitor error', { error: err });
        },
      });
  }

  /** Performs a liveness check and triggers rebuild on timeout */
  private async checkLiveness(): Promise<void> {
    // If there are no active subscriptions, don't perform liveness checks.
    // applesauce-relay may legitimately close sockets after `keepAlive` when
    // nothing is subscribed, and that should not trigger a rebuild.
    if (this.subscriptions.size === 0) {
      logger.debug('Skipping liveness check: no active subscriptions');
      return;
    }

    logger.debug('Running liveness check', {
      activeSubscriptions: this.subscriptions.size,
      relayCount: this.relays.length,
    });

    const relays = this.relays;

    // If no relays in group, trigger rebuild
    if (relays.length === 0) {
      logger.warn('No relays in group, triggering rebuild');
      this.rebuild('no-relays');
      return;
    }

    const connectedRelays = relays.filter((relay) => relay.connected);

    // If relays exist but none connected, trigger rebuild
    if (connectedRelays.length === 0) {
      logger.warn('No connected relays, triggering rebuild', {
        totalRelays: relays.length,
        relayStates: relays.map((r) => ({
          url: r.url,
          connected: r.connected,
        })),
      });
      void this.rebuild('no-connected-relays');
      return;
    }

    const currentGeneration = this.relayGeneration;

    try {
      await Promise.all(
        connectedRelays.map(async (relay, index) => {
          const pingId = `ping:${Date.now()}:${index}`;

          try {
            relay.send(['REQ', pingId, PING_FILTER]);

            await lastValueFrom(
              relay.message$.pipe(
                filter(
                  (msg) =>
                    Array.isArray(msg) &&
                    msg[0] === 'EOSE' &&
                    msg[1] === pingId,
                ),
                take(1),
                timeout(this.pingTimeoutMs),
              ),
            );
          } finally {
            try {
              relay.send(['CLOSE', pingId]);
            } catch {
              // best-effort cleanup
            }
          }
        }),
      );
    } catch (error) {
      if (this.relayGeneration !== currentGeneration) {
        logger.debug('Ignoring liveness timeout because pool was rebuilt', {
          generation: this.relayGeneration,
          pingGeneration: currentGeneration,
        });
        return;
      }

      if (error instanceof Error && error.name === 'TimeoutError') {
        logger.warn('Liveness check timed out - no response from relays', {
          pingTimeoutMs: this.pingTimeoutMs,
          connectedRelays: connectedRelays.length,
        });
      } else {
        logger.warn('Liveness check failed, triggering rebuild', { error });
      }
      this.rebuild('liveness-timeout');
    }
  }

  /** Rebuilds the relay group and replays all subscriptions (single-flight) */
  private rebuild(reason: string): void {
    if (this.rebuildInFlight) return;

    this.rebuildInFlight = (async () => {
      this.relayGeneration += 1;
      logger.info('Rebuilding relay pool', { reason });

      // Pause ping monitor during rebuild to avoid redundant checks
      this.stopPingMonitor();

      // Clean up old relay subscriptions BEFORE creating new ones to prevent leaks
      for (const sub of this.relayObservers) sub.unsubscribe();
      this.relayObservers = [];

      // Best-effort close old relays; rebuild must not block on network teardown.
      for (const relay of this.relays) {
        this.discardRelay(relay);
      }

      // Stop current subscriptions (preserve descriptors for replay)
      this.stopActiveSubscriptions();

      // Create new relays and group (if not disconnected during teardown)
      if (this.isDisconnected) {
        logger.debug('Rebuild aborted: pool disconnected');
        return;
      }
      this.relays = this.relayUrls.map((url) => this.createRelay(url));
      this.relayGroup = new RelayGroup(this.relays);

      // Replay all stored subscription descriptors
      // Note: New subscriptions added during rebuild will be replayed after this completes
      for (const sub of this.subscriptions.values()) {
        sub.unsubscribe = this.createSubscription(
          sub.filters,
          sub.onEvent,
          sub.onEose,
        );
      }

      logger.info('Relay pool rebuilt successfully');

      // Resume ping monitor
      this.startPingMonitor();
    })().finally(() => {
      this.rebuildInFlight = undefined;
    });
  }
}
