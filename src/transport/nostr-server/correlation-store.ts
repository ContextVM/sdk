/**
 * Internal correlation store for NostrServerTransport.
 * Provides O(1) routing for responses and progress notifications.
 *
 * This module is not exported from the public API.
 */

import { LruCache } from '../../core/utils/lru-cache.js';

/**
 * Represents a route for an in-flight request.
 */
export interface EventRoute {
  /** The client's public key that originated this request */
  clientPubkey: string;
  /** The original JSON-RPC request ID (before it was replaced with eventId) */
  originalRequestId: string | number;
  /** Optional progress token for this request */
  progressToken?: string;
}

/**
 * Options for configuring the CorrelationStore.
 */
export interface CorrelationStoreOptions {
  /** Maximum number of event routes to keep in memory */
  maxEventRoutes?: number;
  /** Maximum number of progress token mappings to keep in memory */
  maxProgressTokens?: number;
  /** Callback invoked when an event route is evicted */
  onEventRouteEvicted?: (eventId: string, route: EventRoute) => void;
}

/**
 * Internal store for managing request/response correlation and progress routing.
 *
 * This class maintains two indexes:
 * 1. `eventRoutes`: Maps eventId → EventRoute (clientPubkey, originalRequestId, progressToken)
 * 2. `progressTokenToEventId`: Maps progressToken → eventId
 *
 * This design enables:
 * - O(1) response routing via eventId
 * - O(1) progress notification routing via progressToken
 * - Straightforward cleanup on response or session eviction
 *
 * Memory is bounded by LRU caches to prevent unbounded growth.
 */
export class CorrelationStore {
  private readonly eventRoutes: LruCache<EventRoute>;
  private readonly progressTokenToEventId: LruCache<string>;

  constructor(options: CorrelationStoreOptions = {}) {
    const {
      maxEventRoutes = 10000,
      maxProgressTokens = 10000,
      onEventRouteEvicted,
    } = options;

    this.eventRoutes = new LruCache<EventRoute>(
      maxEventRoutes,
      (eventId, route) => {
        // Clean up progress token mapping when event route is evicted
        if (route.progressToken) {
          this.progressTokenToEventId.delete(route.progressToken);
        }
        onEventRouteEvicted?.(eventId, route);
      },
    );

    this.progressTokenToEventId = new LruCache<string>(maxProgressTokens);
  }

  /**
   * Registers a new event route for an incoming request.
   *
   * @param eventId The Nostr event ID (used as the request ID)
   * @param clientPubkey The client's public key
   * @param originalRequestId The original JSON-RPC request ID
   * @param progressToken Optional progress token for this request
   */
  registerEventRoute(
    eventId: string,
    clientPubkey: string,
    originalRequestId: string | number,
    progressToken?: string,
  ): void {
    const route: EventRoute = {
      clientPubkey,
      originalRequestId,
      progressToken,
    };

    this.eventRoutes.set(eventId, route);

    if (progressToken) {
      this.progressTokenToEventId.set(progressToken, eventId);
    }
  }

  /**
   * Gets the route for a given event ID.
   *
   * @param eventId The Nostr event ID
   * @returns The event route, or undefined if not found
   */
  getEventRoute(eventId: string): EventRoute | undefined {
    return this.eventRoutes.get(eventId);
  }

  /**
   * Gets the event ID for a given progress token.
   *
   * @param progressToken The progress token
   * @returns The event ID, or undefined if not found
   */
  getEventIdByProgressToken(progressToken: string): string | undefined {
    return this.progressTokenToEventId.get(progressToken);
  }

  /**
   * Removes an event route and its associated progress token mapping.
   *
   * @param eventId The Nostr event ID
   * @returns true if the route was found and removed, false otherwise
   */
  removeEventRoute(eventId: string): boolean {
    const route = this.eventRoutes.get(eventId);
    if (!route) {
      return false;
    }

    // Remove progress token mapping if it exists
    if (route.progressToken) {
      this.progressTokenToEventId.delete(route.progressToken);
    }

    // Remove the event route
    this.eventRoutes.delete(eventId);
    return true;
  }

  /**
   * Removes all event routes for a specific client.
   * This is called when a session is evicted or closed.
   *
   * @param clientPubkey The client's public key
   * @returns The number of routes removed
   */
  removeRoutesForClient(clientPubkey: string): number {
    let removed = 0;

    // Iterate over all event routes and remove those matching the client
    const toRemove: string[] = [];
    for (const [eventId, route] of this.eventRoutes.entries()) {
      if (route.clientPubkey === clientPubkey) {
        toRemove.push(eventId);
      }
    }

    for (const eventId of toRemove) {
      if (this.removeEventRoute(eventId)) {
        removed++;
      }
    }

    return removed;
  }

  /**
   * Checks if an event route exists.
   *
   * @param eventId The Nostr event ID
   * @returns true if the route exists, false otherwise
   */
  hasEventRoute(eventId: string): boolean {
    return this.eventRoutes.has(eventId);
  }

  /**
   * Checks if a progress token mapping exists.
   *
   * @param progressToken The progress token
   * @returns true if the mapping exists, false otherwise
   */
  hasProgressToken(progressToken: string): boolean {
    return this.progressTokenToEventId.has(progressToken);
  }

  /**
   * Gets the current number of event routes.
   */
  get eventRouteCount(): number {
    return this.eventRoutes.size;
  }

  /**
   * Gets the current number of progress token mappings.
   */
  get progressTokenCount(): number {
    return this.progressTokenToEventId.size;
  }

  /**
   * Clears all event routes and progress token mappings.
   */
  clear(): void {
    this.eventRoutes.clear();
    this.progressTokenToEventId.clear();
  }
}
