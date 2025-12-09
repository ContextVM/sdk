import { Relay, RelayGroup } from 'applesauce-relay';
import type { NostrEvent, Filter } from 'nostr-tools';
import { RelayHandler } from '../core/interfaces.js';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('applesauce-relay');

/**
 * Subscription information for tracking active subscriptions
 */
interface SubscriptionInfo {
  filters: Filter[];
  onEvent: (event: NostrEvent) => void;
  onEose?: () => void;
  closer: { unsubscribe: () => void };
}

/**
 * A RelayHandler implementation that uses the applesauce-relay library's RelayPool to manage connections and subscriptions.
 */
export class ApplesauceRelayPool implements RelayHandler {
  private readonly relayUrls: string[];
  private readonly relayGroup: RelayGroup;
  private subscriptions: SubscriptionInfo[] = [];

  /**
   * Creates a new ApplesauceRelayPool instance.
   * @param relayUrls - An array of relay URLs to connect to.
   */
  constructor(relayUrls: string[]) {
    this.relayUrls = relayUrls;
    const relays = relayUrls.map(
      (url) => new Relay(url, { publishTimeout: 5000 }),
    );

    // Set up observability for connection state monitoring
    relays.forEach((relay) => {
      relay.connected$.subscribe((isConnected) => {
        logger.debug(`Connection status changed`, {
          relayUrl: relay.url,
          connected: isConnected,
        });
      });

      relay.error$.subscribe((error) => {
        if (error) {
          logger.error(`Relay connection error`, {
            relayUrl: relay.url,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });

    this.relayGroup = new RelayGroup(relays);
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

    try {
      const responses = await this.relayGroup.publish(event, {
        reconnect: true,
      });

      const failedResponses = responses.filter((response) => !response.ok);
      const successCount = responses.length - failedResponses.length;

      // Only throw an error if ALL relays failed to publish
      if (successCount === 0) {
        throw new Error('Failed to publish event to any relay');
      }

      if (failedResponses.length > 0) {
        logger.warn('Failed to publish event to some relays', {
          eventId: event.id,
          failedCount: failedResponses.length,
          successCount,
        });
      } else {
        logger.debug('Event published successfully', { eventId: event.id });
      }
    } catch (error) {
      logger.error('Failed to publish event', { eventId: event.id, error });
      throw error;
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
  ): { unsubscribe: () => void } {
    logger.debug('Creating subscription with filters', {
      filters,
      relayUrls: this.relayUrls,
    });

    const subscription = this.relayGroup.subscription(filters, {
      reconnect: Infinity,
      resubscribe: true,
    });

    const sub = subscription.subscribe({
      next: (response) => {
        if (response === 'EOSE') {
          logger.debug('Received EOSE signal');
          onEose?.();
        } else {
          logger.debug('Received event', {
            eventId: response.id,
            kind: response.kind,
          });
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

    return {
      unsubscribe: () => {
        logger.debug('Unsubscribing from subscription');
        sub.unsubscribe();
      },
    };
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
    logger.debug('Creating subscription', { filters });

    try {
      const closer = this.createSubscription(filters, onEvent, onEose);
      this.subscriptions.push({
        filters,
        onEvent,
        onEose,
        closer,
      });
    } catch (error) {
      logger.error('Failed to create subscription', { filters, error });
      throw error;
    }
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
      for (const subscription of this.subscriptions) {
        subscription.closer.unsubscribe();
      }
      this.subscriptions = [];
    } catch (error) {
      logger.error('Error while unsubscribing from subscriptions', { error });
    }
  }
}
