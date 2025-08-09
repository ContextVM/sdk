import { NPool, NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent, Filter } from 'nostr-tools';
import { RelayHandler } from '../core/interfaces.js';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('nostrify-relay');

/**
 * A RelayHandler implementation that uses the nostrify library's NPool to manage connections and subscriptions.
 */
export class NostrifyRelayPool implements RelayHandler {
  private readonly pool: NPool;
  private readonly relayUrls: string[];

  // Subscription management similar to SimpleRelayPool
  private subscriptions: Array<{
    filters: Filter[];
    onEvent: (event: NostrEvent) => void;
    onEose?: () => void;
    closer: { close: () => void };
  }> = [];

  /**
   * Creates a new NostrifyRelayPool instance.
   * @param relayUrls - An array of relay URLs to connect to.
   */
  constructor(relayUrls: string[]) {
    this.relayUrls = relayUrls;

    this.pool = new NPool({
      open: (url) => new NRelay1(url),
      reqRouter: (filters) => {
        const relayMap = new Map<string, Filter[]>();
        relayUrls.forEach((url) => {
          relayMap.set(url, filters);
        });
        return relayMap;
      },
      eventRouter: () => {
        return relayUrls;
      },
    });
  }

  async connect(): Promise<void> {
    logger.info('Connecting to relays', { relayUrls: this.relayUrls });

    // The NPool automatically connects to relays when needed
    // We don't need to explicitly connect here, but we could validate the relay URLs
    for (const url of this.relayUrls) {
      try {
        // Validate URL format
        new URL(url);
      } catch (error) {
        logger.error('Invalid relay URL', { url, error });
        throw new Error(`Invalid relay URL: ${url}`);
      }
    }

    logger.info('Relay pool initialized', { relayUrls: this.relayUrls });
  }

  async disconnect(): Promise<void> {
    this.pool.close();
  }

  async publish(event: NostrEvent): Promise<void> {
    logger.debug('Publishing event', { eventId: event.id, kind: event.kind });

    try {
      await this.pool.event(event);
      logger.debug('Event published successfully', { eventId: event.id });
    } catch (error) {
      logger.error('Failed to publish event', { eventId: event.id, error });
      throw error;
    }
  }

  /**
   * Creates a simplified subscription wrapper around the NPool's req method.
   * This provides a cleaner interface similar to SimplePool's subscribeMany.
   */
  private createSubscription(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): { close: () => void } {
    const abortController = new AbortController();

    // Start the subscription in the background
    (async () => {
      try {
        const messageStream = this.pool.req(filters, {
          signal: abortController.signal,
        });

        let eoseReceived = false;

        for await (const message of messageStream) {
          if (abortController.signal.aborted) break;

          if (message[0] === 'EVENT') {
            const event = message[2];
            onEvent(event);
          } else if (message[0] === 'EOSE' && !eoseReceived && onEose) {
            eoseReceived = true;
            onEose();
          } else if (message[0] === 'CLOSED') {
            // Subscription was closed by the relay
            break;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          logger.debug('Subscription aborted');
        } else {
          logger.error('Subscription error', { error });
        }
      }
    })();

    return {
      close: () => abortController.abort(),
    };
  }

  async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): Promise<void> {
    logger.debug('Creating subscription', { filters });

    // Create a subscription using our simplified wrapper
    const closer = this.createSubscription(filters, onEvent, onEose);

    // Store the subscription for cleanup
    this.subscriptions.push({
      filters,
      onEvent,
      onEose,
      closer,
    });
  }

  unsubscribe(): void {
    logger.debug('Unsubscribing from all subscriptions');

    // Close all active subscriptions
    for (const subscription of this.subscriptions) {
      subscription.closer.close();
    }

    this.subscriptions = [];
  }
}
