import { Relay, RelayGroup } from 'applesauce-relay';
import type { NostrEvent, Filter } from 'nostr-tools';
import { RelayHandler } from '../core/interfaces.js';
import { createLogger } from '../core/utils/logger.js';
import { sleep } from '../core/utils/utils.js';
import { timer, type Observable } from 'rxjs';

const logger = createLogger('applesauce-relay');

/**
 * RelayHandler implementation backed by applesauce-relay.
 */
export class ApplesauceRelayPool implements RelayHandler {
  private readonly relayUrls: string[];
  private readonly relayGroup: RelayGroup;
  private subscriptions: Array<() => void> = [];

  // Outbound publish policy
  private static readonly PUBLISH_ATTEMPT_TIMEOUT_MS = 10_000;
  private static readonly PUBLISH_RETRY_INTERVAL_MS = 500;
  private static readonly PUBLISH_ERROR_LOG_INTERVAL_MS = 10_000;

  // Reconnect backoff policy
  private static readonly RECONNECT_BASE_DELAY_MS = 3_000;
  private static readonly RECONNECT_MAX_DELAY_MS = 30_000;

  private createRelay(url: string): Relay {
    const relay = new Relay(url);

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

    // Observability for connection state monitoring
    relay.connected$.subscribe((connected) => {
      logger.debug('Connection status changed', {
        relayUrl: relay.url,
        connected,
      });
    });

    relay.error$.subscribe((error) => {
      if (!error) return;
      logger.error('Relay connection error', {
        relayUrl: relay.url,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return relay;
  }

  /**
   * Creates a new ApplesauceRelayPool instance.
   * @param relayUrls - An array of relay URLs to connect to.
   */
  constructor(relayUrls: string[]) {
    this.relayUrls = relayUrls;

    this.relayGroup = new RelayGroup(
      relayUrls.map((url) => this.createRelay(url)),
    );
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
    this.subscriptions.push(this.createSubscription(filters, onEvent, onEose));
  }

  /**
   * Disconnects from all relays and cleans up resources.
   */
  async disconnect(): Promise<void> {
    this.unsubscribe();
    logger.debug('Disconnected from all relays');
  }

  /**
   * Unsubscribes from all active subscriptions.
   */
  unsubscribe(): void {
    logger.debug('Unsubscribing from all subscriptions');

    try {
      for (const unsubscribe of this.subscriptions) unsubscribe();
      this.subscriptions = [];
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
}
