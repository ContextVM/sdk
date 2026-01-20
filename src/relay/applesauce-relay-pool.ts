import { Relay, RelayGroup } from 'applesauce-relay';
import type { NostrEvent, Filter } from 'nostr-tools';
import { RelayHandler } from '../core/interfaces.js';
import { createLogger } from '../core/utils/logger.js';
import { sleep } from '../core/utils/utils.js';
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
  merge,
} from 'rxjs';

const logger = createLogger('applesauce-relay');

/** Dummy filter that returns no results, used for liveness ping */
export const PING_FILTER: Filter = {
  ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  limit: 0,
};

/** Subscription intent stored for replay after rebuild */
type SubscriptionDescriptor = {
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
};

/** Configuration options for ApplesauceRelayPool */
export interface ApplesauceRelayPoolOptions {
  /** Ping frequency in ms (default: 30000) */
  pingFrequencyMs?: number;
  /** Ping timeout in ms (default: 20000) */
  pingTimeoutMs?: number;
}

/**
 * RelayHandler implementation backed by applesauce-relay.
 */
export class ApplesauceRelayPool implements RelayHandler {
  private readonly relayUrls: string[];
  private relayGroup: RelayGroup;
  private subscriptionDescriptors: SubscriptionDescriptor[] = [];
  private activeUnsubscribers: Array<() => void> = [];

  // Outbound publish policy
  private static readonly PUBLISH_ATTEMPT_TIMEOUT_MS = 10_000;
  private static readonly PUBLISH_RETRY_INTERVAL_MS = 500;
  private static readonly PUBLISH_ERROR_LOG_INTERVAL_MS = 10_000;

  // Reconnect backoff policy
  private static readonly RECONNECT_BASE_DELAY_MS = 3_000;
  private static readonly RECONNECT_MAX_DELAY_MS = 30_000;

  // Liveness ping policy (instance-configurable)
  private readonly pingFrequencyMs: number;
  private readonly pingTimeoutMs: number;
  // Liveness tracking
  private pingSubscription?: Subscription;
  private readonly destroy$ = new Subject<void>();
  private rebuildInFlight?: Promise<void>;
  private relayObservers: Subscription[] = [];
  private relays: Relay[] = [];

  /**
   * Safely completes an RxJS Subject or BehaviorSubject if it exists and isn't already closed.
   * This is a defensive measure to prevent memory leaks from incomplete cleanup in external libraries.
   */
  private completeSubjectSafely(
    subject: { complete?: () => void; closed?: boolean } | undefined,
  ): void {
    if (subject && typeof subject.complete === 'function' && !subject.closed) {
      try {
        subject.complete();
      } catch {
        // Subject might already be completed or errored; ignore
      }
    }
  }

  /**
   * Safely closes a relay and completes all its RxJS subjects to prevent memory leaks.
   *
   */
  private safelyCloseRelay(relay: Relay): void {
    try {
      // Call the native close method first
      relay.close();

      // Collect all subjects to clean up in a single pass
      const subjects: (
        | { complete?: () => void; closed?: boolean }
        | undefined
      )[] = [
        // Public BehaviorSubjects
        relay.connected$,
        relay.attempts$,
        relay.challenge$,
        relay.authenticationResponse$,
        relay.notices$,
        relay.error$,
        // Public Subjects
        relay.open$,
        relay.close$,
        relay.closing$,
        // Internal BehaviorSubjects (accessed via structural typing)
        (
          relay as Relay & {
            _ready$?: { complete?: () => void; closed?: boolean };
          }
        )._ready$,
        (
          relay as Relay & {
            receivedAuthRequiredForReq?: {
              complete?: () => void;
              closed?: boolean;
            };
          }
        ).receivedAuthRequiredForReq,
        (
          relay as Relay & {
            receivedAuthRequiredForEvent?: {
              complete?: () => void;
              closed?: boolean;
            };
          }
        ).receivedAuthRequiredForEvent,
      ];

      // Complete all subjects
      subjects.forEach((s) => this.completeSubjectSafely(s));

      logger.debug('Completed all subjects for relay', { url: relay.url });
    } catch (error) {
      logger.warn('Error during relay cleanup', {
        url: relay.url,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - best effort cleanup
    }
  }

  private createRelay(url: string): Relay {
    // NOTE: applesauce-relay uses `keepAlive` as the delay before tearing down the
    // websocket after the last subscription is unsubscribed.
    //
    // We set it to slightly larger than our liveness
    // cadence so that short gaps don't cause unnecessary disconnect/reconnect.
    const relay = new Relay(url, {
      keepAlive: this.pingFrequencyMs + this.pingTimeoutMs + 5_000,
    });

    // Ensure reconnect attempts continue at a bounded cadence even after many
    // failures, so a relay coming back online is picked up quickly.
    relay.reconnectTimer = (
      _error: Error | CloseEvent,
      tries = 0,
    ): Observable<number> => {
      const delay = Math.min(
        Math.pow(1.5, tries) * ApplesauceRelayPool.RECONNECT_BASE_DELAY_MS,
        ApplesauceRelayPool.RECONNECT_MAX_DELAY_MS,
      );
      return timer(delay);
    };

    // Observability for connection state monitoring (tracked for cleanup on rebuild)
    const connectedSub = relay.connected$.subscribe((connected) => {
      logger.debug('Connection status changed', {
        relayUrl: relay.url,
        connected,
      });
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
  async publish(event: NostrEvent): Promise<void> {
    logger.debug('Publishing event', { eventId: event.id, kind: event.kind });

    // NOTE: Publishing is intentionally retried indefinitely.
    // MCP JSON-RPC round-trips cannot complete without delivering responses.
    let lastLogAt = 0;
    let attempt = 0;

    while (true) {
      attempt += 1;
      try {
        const responses = await this.relayGroup.publish(event, {
          timeout: ApplesauceRelayPool.PUBLISH_ATTEMPT_TIMEOUT_MS,
          retries: 0,
        });

        let successCount = 0;
        let failedCount = 0;
        for (const response of responses) {
          if (response.ok) successCount += 1;
          else failedCount += 1;
        }

        if (successCount === 0) throw new Error('Failed to publish event');

        if (failedCount > 0) {
          logger.warn('Failed to publish event to some relays', {
            eventId: event.id,
            failedCount,
            successCount,
          });
        } else {
          logger.debug('Event published successfully', { eventId: event.id });
        }
        return;
      } catch (error) {
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

    const subscription = this.relayGroup.subscription(filters, {
      reconnect: Infinity,
      resubscribe: Infinity,
    });

    const sub = subscription.subscribe({
      next: (response) => {
        if (response === 'EOSE') {
          onEose?.();
        } else {
          onEvent(response);
        }
      },
      complete: () => {
        logger.debug('Subscription complete');
      },
      error: (error) => {
        logger.error('Subscription error', {
          error,
          relayUrls: this.relayUrls,
        });
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
  ): Promise<void> {
    // Store the descriptor for replay after rebuild
    this.subscriptionDescriptors.push({ filters, onEvent, onEose });
    // Start the subscription and store the unsubscribe handle
    this.activeUnsubscribers.push(
      this.createSubscription(filters, onEvent, onEose),
    );
    // Start ping monitor lazily on first subscription
    logger.debug('Starting ping monitor from subscribe', {
      activeUnsubscribers: this.activeUnsubscribers.length,
    });
    this.startPingMonitor();
  }

  /**
   * Disconnects from all relays and cleans up resources.
   */
  async disconnect(): Promise<void> {
    this.destroy$.next();
    this.destroy$.complete();
    this.unsubscribe();

    // Clean up relay observers
    for (const sub of this.relayObservers) sub.unsubscribe();
    this.relayObservers = [];

    // Safely close all relays and complete their subjects
    for (const relay of this.relays) {
      this.safelyCloseRelay(relay);
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
      for (const unsubscribe of this.activeUnsubscribers) unsubscribe();
      this.activeUnsubscribers = [];
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
      this.stopActiveSubscriptions();
      this.subscriptionDescriptors = [];
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
    if (this.pingSubscription) {
      logger.debug('Ping monitor already started, skipping');
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
    if (this.activeUnsubscribers.length === 0) {
      logger.debug('Skipping liveness check: no active subscriptions');
      return;
    }

    logger.debug('Running liveness check', {
      activeUnsubscribers: this.activeUnsubscribers.length,
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

    const pingId = `ping:${Date.now()}`;

    try {
      // Send pings to all connected relays using the internal send method
      // Cast to Relay to access the non-interface send method
      for (const relay of connectedRelays) {
        try {
          (relay as Relay).send(['REQ', pingId, PING_FILTER]);
        } catch (error) {
          // If send fails immediately, log but continue - timeout will catch it
          logger.debug('Failed to send ping to relay', {
            url: relay.url,
            error,
          });
        }
      }

      // Wait for any response with timeout using raw message stream
      await lastValueFrom(
        merge(...connectedRelays.map((relay) => relay.message$)).pipe(
          filter(
            (msg) =>
              Array.isArray(msg) && msg[0] === 'EOSE' && msg[1] === pingId,
          ),
          take(1),
          timeout(this.pingTimeoutMs),
        ),
      );
    } catch (error) {
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
      logger.info('Rebuilding relay pool', { reason });

      // Pause ping monitor during rebuild to avoid redundant checks
      this.stopPingMonitor();

      // Clean up old relay subscriptions BEFORE creating new ones to prevent leaks
      for (const sub of this.relayObservers) sub.unsubscribe();
      this.relayObservers = [];

      // Safely close old relays and complete their subjects to prevent memory leaks
      for (const relay of this.relays) {
        this.safelyCloseRelay(relay);
      }

      // Stop current subscriptions (preserve descriptors for replay)
      this.stopActiveSubscriptions();

      // Create new relays and group
      this.relays = this.relayUrls.map((url) => this.createRelay(url));
      this.relayGroup = new RelayGroup(this.relays);

      // Replay all stored subscription descriptors
      // Note: New subscriptions added during rebuild will be replayed after this completes
      for (const desc of this.subscriptionDescriptors) {
        this.activeUnsubscribers.push(
          this.createSubscription(desc.filters, desc.onEvent, desc.onEose),
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
