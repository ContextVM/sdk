import { SimplePool, type Filter, type NostrEvent } from 'nostr-tools';
import type { SubCloser } from 'nostr-tools/abstract-pool';
import { RelayHandler } from '../core/interfaces.js';
import { sleep } from '../core/utils/utils.js';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('relay');

/**
 * A RelayHandler implementation that uses a SimplePool to manage connections and subscriptions.
 * Implements exponential backoff for reconnection attempts when relays drop connections.
 * @argument relayUrls - An array of relay URLs to connect to.
 * @returns A RelayHandler implementation that uses a SimplePool to manage connections and subscriptions.
 */
export class SimpleRelayPool implements RelayHandler {
  private readonly relayUrls: string[];
  private readonly normalizedRelayUrls: string[];
  private pool: SimplePool;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private readonly maxRetries = 5;

  // Use Map for more efficient relay state management
  private relayStates = new Map<
    string,
    {
      reconnectInterval: number;
      retryCount: number;
      isReconnecting: boolean;
    }
  >();

  private subscriptions: Array<{
    filters: Filter[];
    onEvent: (event: NostrEvent) => void;
    onEose?: () => void;
    closer?: SubCloser;
  }> = [];

  constructor(relayUrls: string[]) {
    this.relayUrls = relayUrls;
    // Normalize URLs once during construction
    this.normalizedRelayUrls = relayUrls.map((url) => new URL(url).href);
    // Initialize relay states
    this.normalizedRelayUrls.forEach((url) => {
      this.relayStates.set(url, {
        reconnectInterval: 1000,
        retryCount: 0,
        isReconnecting: false,
      });
    });
    this.pool = new SimplePool();
    this.startReconnectLoop();
  }

  /**
   * Starts a loop that periodically checks connection status and reconnects if needed
   * using exponential backoff strategy.
   */
  private startReconnectLoop(): void {
    // Clear any existing timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    // Check all relays every 5 seconds
    this.reconnectTimer = setTimeout(() => {
      const connectionStatus = this.pool.listConnectionStatus();
      this.relayStates.forEach((state, url) => {
        if (!connectionStatus.get(url)) {
          this.handleDisconnectedRelay(url);
        }
      });
      this.startReconnectLoop(); // Schedule next check
    }, 5000);
  }

  async connect(): Promise<void> {
    // Connect to all relays with exponential backoff tracking
    const connectionStatus = this.pool.listConnectionStatus();
    await Promise.all(
      this.normalizedRelayUrls.map(async (url) => {
        if (!connectionStatus.get(url)) {
          await this.handleDisconnectedRelay(url);
        }
      }),
    );
  }

  /**
   * Handles a disconnected relay with exponential backoff strategy.
   * @param normalizedUrl - The normalized relay URL to reconnect to
   */
  private async handleDisconnectedRelay(normalizedUrl: string): Promise<void> {
    // Get the relay state
    const relayState = this.relayStates.get(normalizedUrl);
    if (!relayState) return;

    // Skip if already reconnecting to this relay
    if (relayState.isReconnecting) {
      return;
    }

    // Check if we've exceeded the maximum retry count
    if (relayState.retryCount >= this.maxRetries) {
      logger.warn(
        `Maximum reconnection attempts (${this.maxRetries}) reached for relay ${normalizedUrl}. Giving up.`,
      );
      return;
    }

    const currentInterval = relayState.reconnectInterval;

    // Check if we should wait before attempting to reconnect
    if (currentInterval > 1000) {
      await sleep(currentInterval);
    }

    // Mark as reconnecting and increment retry count
    relayState.isReconnecting = true;
    relayState.retryCount++;
    this.pool['relays'].delete(normalizedUrl);

    try {
      await this.pool.ensureRelay(normalizedUrl, { connectionTimeout: 5000 });
      // Reset backoff interval and retry count on successful connection
      relayState.reconnectInterval = 1000;
      relayState.retryCount = 0;

      // Resubscribe to all active subscriptions after successful reconnection
      this.resubscribeAll();
    } catch (error) {
      logger.error(
        `Can't connect to relay ${normalizedUrl} (attempt ${relayState.retryCount}/${this.maxRetries})`,
        error,
      );
      // Double the interval for next attempt (exponential backoff), capped at 30 seconds
      relayState.reconnectInterval = Math.min(currentInterval * 2, 30000);
    } finally {
      // Remove from reconnecting set
      relayState.isReconnecting = false;
    }
  }

  /**
   * Resubscribes to all active subscriptions after relay reconnection
   */
  private resubscribeAll(): void {
    this.subscriptions.forEach((sub) => {
      if (sub.closer) sub.closer.close();
      sub.closer = this.pool.subscribeMany(
        this.normalizedRelayUrls,
        sub.filters,
        {
          onevent: sub.onEvent,
          oneose: sub.onEose,
        },
      );
    });
  }

  async disconnect(relayUrls?: string[]): Promise<void> {
    if (!relayUrls) {
      relayUrls = this.relayUrls;

      // Reset all relay states when disconnecting all relays
      this.relayStates.forEach((state) => {
        state.reconnectInterval = 1000;
        state.retryCount = 0;
        state.isReconnecting = false;
      });

      // Clear the reconnect loop timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
    } else {
      // Reset relay states for specific relays
      const normalizedUrls = relayUrls.map((url) => new URL(url).href);
      normalizedUrls.forEach((url) => {
        const state = this.relayStates.get(url);
        if (state) {
          state.reconnectInterval = 1000;
          state.retryCount = 0;
          state.isReconnecting = false;
        }
      });
    }

    this.pool.close(relayUrls);
    await sleep(100);
  }

  async publish(event: NostrEvent): Promise<void> {
    await Promise.all(this.pool.publish(this.normalizedRelayUrls, event));
  }

  async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
    onEose?: () => void,
  ): Promise<void> {
    const closer = this.pool.subscribeMany(this.normalizedRelayUrls, filters, {
      onevent: onEvent,
      oneose: onEose,
    });
    this.subscriptions.push({ filters, onEvent, onEose, closer });
  }

  unsubscribe(): void {
    this.subscriptions.forEach((sub) => sub.closer?.close());
    this.subscriptions = [];
  }
}
