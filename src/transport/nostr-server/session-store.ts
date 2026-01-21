/**
 * Internal session store for NostrServerTransport.
 * Manages client sessions with LRU eviction.
 *
 * This module is not exported from the public API.
 */
import { DEFAULT_LRU_SIZE } from '../../core/constants.js';
import { LruCache } from '../../core/utils/lru-cache.js';
/**
 * Represents a connected client session.
 * Simplified from the original design - correlation data is now
 * managed separately by CorrelationStore.
 */
export interface ClientSession {
  /** Whether the client has completed the initialize handshake */
  isInitialized: boolean;
  /** Whether this session uses encryption */
  isEncrypted: boolean;
  /** Timestamp of the last activity from this client */
  lastActivity: number;
}

/**
 * Options for configuring the SessionStore.
 */
export interface SessionStoreOptions {
  /** Maximum number of sessions to keep in memory */
  maxSessions?: number;
  /** Callback invoked when a session is evicted */
  onSessionEvicted?: (clientPubkey: string, session: ClientSession) => void;
  /**
   * Predicate called during LRU eviction to determine if a session should be evicted.
   * Return true to proceed with eviction, false to keep the session.
   * If not provided, all LRU evictions proceed normally.
   */
  shouldEvictSession?: (
    clientPubkey: string,
    session: ClientSession,
  ) => boolean;
}

/**
 * Internal store for managing client sessions.
 *
 * This class maintains an LRU cache of client sessions, automatically
 * evicting the least recently used sessions when the capacity is reached.
 *
 * Session data is kept minimal - correlation data (request IDs, progress tokens)
 * is managed separately by CorrelationStore for better separation of concerns.
 */
export class SessionStore {
  private readonly sessions: LruCache<ClientSession>;

  constructor(options: SessionStoreOptions = {}) {
    const {
      maxSessions = DEFAULT_LRU_SIZE,
      onSessionEvicted,
      shouldEvictSession,
    } = options;

    this.sessions = new LruCache<ClientSession>(
      maxSessions,
      (clientPubkey, session) => {
        // Check if eviction should proceed via predicate
        if (shouldEvictSession && !shouldEvictSession(clientPubkey, session)) {
          // Re-insert the session to prevent eviction
          this.sessions.set(clientPubkey, session);
          return;
        }
        onSessionEvicted?.(clientPubkey, session);
      },
    );
  }

  /**
   * Gets or creates a session for a client.
   *
   * @param clientPubkey The client's public key
   * @param isEncrypted Whether the session uses encryption
   * @returns The client session
   */
  getOrCreateSession(
    clientPubkey: string,
    isEncrypted: boolean,
  ): ClientSession {
    const existing = this.sessions.get(clientPubkey);
    if (existing) {
      // Update encryption mode in case it changed
      existing.isEncrypted = isEncrypted;
      return existing;
    }

    const newSession: ClientSession = {
      isInitialized: false,
      isEncrypted,
      lastActivity: Date.now(),
    };

    this.sessions.set(clientPubkey, newSession);
    return newSession;
  }

  /**
   * Gets a session for a client without creating one if it doesn't exist.
   *
   * @param clientPubkey The client's public key
   * @returns The client session, or undefined if not found
   */
  getSession(clientPubkey: string): ClientSession | undefined {
    return this.sessions.get(clientPubkey);
  }

  /**
   * Updates the last activity timestamp for a session.
   *
   * @param clientPubkey The client's public key
   * @returns true if the session was found and updated, false otherwise
   */
  updateActivity(clientPubkey: string): boolean {
    const session = this.sessions.get(clientPubkey);
    if (session) {
      session.lastActivity = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Marks a session as initialized.
   *
   * @param clientPubkey The client's public key
   * @returns true if the session was found and updated, false otherwise
   */
  markInitialized(clientPubkey: string): boolean {
    const session = this.sessions.get(clientPubkey);
    if (session) {
      session.isInitialized = true;
      return true;
    }
    return false;
  }

  /**
   * Checks if a session exists.
   *
   * @param clientPubkey The client's public key
   * @returns true if the session exists, false otherwise
   */
  hasSession(clientPubkey: string): boolean {
    return this.sessions.has(clientPubkey);
  }

  /**
   * Removes a session.
   *
   * @param clientPubkey The client's public key
   * @returns true if the session was found and removed, false otherwise
   */
  removeSession(clientPubkey: string): boolean {
    return this.sessions.delete(clientPubkey);
  }

  /**
   * Gets all sessions.
   *
   * @returns An iterable of [clientPubkey, session] tuples
   */
  getAllSessions(): IterableIterator<[string, ClientSession]> {
    return this.sessions.entries();
  }

  /**
   * Gets the number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Clears all sessions.
   */
  clear(): void {
    this.sessions.clear();
  }
}
