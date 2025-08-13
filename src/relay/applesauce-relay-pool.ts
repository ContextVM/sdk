import { RelayGroup, RelayPool } from 'applesauce-relay';
import type { NostrEvent, Filter } from 'nostr-tools';
import { RelayHandler } from '../core/interfaces.js';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('applesauce-relay');

/**
 * Interface for subscription information
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
  private readonly pool: RelayPool;
  private readonly relayUrls: string[];
  private readonly relayGroup: RelayGroup;

  // Subscription management similar to other relay pools
  private subscriptions: Array<SubscriptionInfo> = [];

  /**
   * Creates a new ApplesauceRelayPool instance.
   * @param relayUrls - An array of relay URLs to connect to.
   */
  constructor(relayUrls: string[]) {
    this.relayUrls = relayUrls;
    this.pool = new RelayPool();
    this.relayGroup = this.pool.group(relayUrls);
    this.setupConnectionMonitoring();
  }

  /**
   * Sets up monitoring of relay connections and triggers resubscription when connections are lost
   */
  private setupConnectionMonitoring(): void {
    this.pool.relays$.subscribe((relays) => {
      relays.forEach((relay) => {
        relay.connected$.subscribe((connected) => {
          if (!connected) {
            this.resubscribeAll();
          }
        });
      });
    });
  }

  async connect(): Promise<void> {
    logger.info('Connecting to relays', { relayUrls: this.relayUrls });

    // Validate URL format
    for (const url of this.relayUrls) {
      try {
        new URL(url);
      } catch (error) {
        logger.error('Invalid relay URL', { url, error });
        throw new Error(`Invalid relay URL: ${url}`);
      }
    }

    // The RelayPool automatically connects to relays when needed
    logger.info('Relay pool initialized', { relayUrls: this.relayUrls });
  }

  async publish(event: NostrEvent): Promise<void> {
    logger.debug('Publishing event', { eventId: event.id, kind: event.kind });

    // Use the publish method which handles retries automatically
    const publishObservable = this.relayGroup.publish(event);

    // Subscribe to the publish observable to handle responses
    return new Promise<void>((resolve, reject) => {
      const subscription = publishObservable.subscribe({
        next: (response) => {
          if (!response.ok) {
            logger.warn('Failed to publish event to relay', {
              eventId: event.id,
              relay: response.from,
              message: response.message,
            });
          }
        },
        error: (error) => {
          logger.error('Failed to publish event', {
            eventId: event.id,
            error,
          });
          reject(error);
        },
        complete: () => {
          logger.debug('Event publishing completed', { eventId: event.id });
          subscription.unsubscribe();
          resolve();
        },
      });
    });
  }

  /**
   * Creates a simplified subscription wrapper around the RelayPool's subscription method.
   * This provides a cleaner interface similar to other relay pool implementations.
   */
  private createSubscription(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): { unsubscribe: () => void } {
    // Create a persistent subscription with automatic reconnection
    const subscription = this.relayGroup.subscription(filters, {
      retries: 3,
    });

    // Subscribe to the stream of events
    const sub = subscription.subscribe({
      next: (response) => {
        if (response === 'EOSE') {
          onEose?.();
        } else {
          onEvent(response);
        }
      },
      error: (error) => {
        logger.error('Subscription error', { error });
        // Remove the subscription from the array if it fails
        const index = this.subscriptions.findIndex(
          (sub) => sub.onEvent === onEvent && sub.filters === filters,
        );
        if (index !== -1) {
          this.subscriptions.splice(index, 1);
        }
        sub.unsubscribe();
      },
    });

    return {
      unsubscribe: () => {
        sub.unsubscribe();
      },
    };
  }

  /**
   * Resubscribes to all active subscriptions after relay reconnection
   */
  private resubscribeAll(): void {
    logger.debug('Resubscribing to all subscriptions after relay reconnection');

    try {
      this.subscriptions.forEach((sub) => {
        if (sub.closer) sub.closer.unsubscribe();
        sub.closer = this.createSubscription(
          sub.filters,
          sub.onEvent,
          sub.onEose,
        );
      });
    } catch (error) {
      logger.error('Failed to resubscribe to subscriptions', { error });
    }
  }

  async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): Promise<void> {
    logger.debug('Creating subscription', { filters });

    try {
      // Create a subscription using our simplified wrapper
      const closer = this.createSubscription(filters, onEvent, onEose);

      // Store the subscription for cleanup
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

  async disconnect(): Promise<void> {
    logger.info('Disconnecting from relays');

    // Close all active subscriptions
    this.unsubscribe();

    // Close the relay pool
    // Note: RelayPool doesn't have a close method, connections are managed automatically
    // We just need to clear our subscriptions
    logger.info('Disconnected from all relays');
  }

  unsubscribe(): void {
    logger.debug('Unsubscribing from all subscriptions');

    try {
      // Close all active subscriptions
      for (const subscription of this.subscriptions) {
        subscription.closer.unsubscribe();
      }

      this.subscriptions = [];
    } catch (error) {
      logger.error('Error while unsubscribing from subscriptions', { error });
    }
  }
}
