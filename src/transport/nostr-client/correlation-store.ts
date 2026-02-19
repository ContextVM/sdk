import type { JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';
import { LruCache } from '../../core/utils/lru-cache.js';

/**
 * Represents a pending request waiting for a response from the server.
 * Tracks the original request ID for response correlation and whether
 * this is an initialize request.
 */
export interface PendingRequest {
  /** The original JSON-RPC request ID to restore in the response */
  originalRequestId: string | number | null;
  /** Whether this request is the initialize handshake */
  isInitialize: boolean;
  /** Optional MCP progress token (present when the request was sent with `onprogress`) */
  progressToken?: string;
}

/**
 * Configuration options for the ClientCorrelationStore.
 */
export interface ClientCorrelationStoreOptions {
  /** Maximum number of pending requests to track (default: 1000) */
  maxPendingRequests?: number;
  /** Callback invoked when a request is evicted from the cache */
  onRequestEvicted?: (eventId: string, request: PendingRequest) => void;
}

/**
 * Manages correlation tracking for client-side request/response pairs.
 * Uses an LRU cache to prevent memory leaks from abandoned requests.
 */
export class ClientCorrelationStore {
  private readonly pendingRequests: LruCache<PendingRequest>;

  constructor(options: ClientCorrelationStoreOptions = {}) {
    const { maxPendingRequests = 1000, onRequestEvicted } = options;
    this.pendingRequests = new LruCache<PendingRequest>(
      maxPendingRequests,
      onRequestEvicted,
    );
  }

  /**
   * Registers a pending request for correlation tracking.
   * @param eventId - The Nostr event ID used as the correlation key
   * @param request - The pending request information
   */
  registerRequest(eventId: string, request: PendingRequest): void {
    this.pendingRequests.set(eventId, request);
  }

  /**
   * Gets a pending request without removing it.
   *
   * Intended for transport-level features that need request metadata
   * (e.g. synthetic progress injection).
   */
  getPendingRequest(eventId: string): PendingRequest | undefined {
    return this.pendingRequests.get(eventId);
  }

  /**
   * Resolves a response by finding and removing the corresponding request.
   * Restores the original request ID in the response before resolving.
   * @param eventId - The Nostr event ID of the response
   * @param response - The JSON-RPC response to resolve
   * @returns true if the request was found and resolved, false otherwise
   */
  resolveResponse(eventId: string, response: JSONRPCResponse): boolean {
    const request = this.pendingRequests.get(eventId);
    if (!request) return false;
    if (request.originalRequestId !== null) {
      response.id = request.originalRequestId;
    }
    this.pendingRequests.delete(eventId);
    return true;
  }

  /**
   * Checks if a pending request exists for the given event ID.
   * @param eventId - The Nostr event ID to check
   * @returns true if a request exists, false otherwise
   */
  hasPendingRequest(eventId: string): boolean {
    return this.pendingRequests.has(eventId);
  }

  /**
   * Removes a pending request without resolving it.
   * @param eventId - The Nostr event ID of the request to remove
   * @returns true if the request was found and removed, false otherwise
   */
  removePendingRequest(eventId: string): boolean {
    return this.pendingRequests.delete(eventId);
  }

  /** Gets the current number of pending requests */
  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /** Clears all pending requests from the store */
  clear(): void {
    this.pendingRequests.clear();
  }
}
