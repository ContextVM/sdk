import type { NostrEvent } from 'nostr-tools';

const nostrRequestContexts = new Map<string, NostrEvent>();

/**
 * Stores an inbound Nostr request context under the given request event id.
 *
 * @param requestEventId The inbound signed Nostr request event id.
 * @param context The request context to store.
 */
export function setNostrRequestContext(
  requestEventId: string,
  context: NostrEvent,
): void {
  nostrRequestContexts.set(requestEventId, context);
}

/**
 * Gets a stored Nostr request context by inbound request event id.
 *
 * @param requestEventId The inbound signed Nostr request event id.
 * @returns The stored Nostr request context or `undefined`.
 */
export function getNostrRequestContext(
  requestEventId: string,
): NostrEvent | undefined {
  return nostrRequestContexts.get(requestEventId);
}

/**
 * Gets the inbound signed Nostr event for a given request event id, if
 * available.
 *
 * @param requestEventId The inbound signed Nostr request event id.
 * @returns The signed Nostr request event or `undefined`.
 */
export function getNostrRequestEvent(
  requestEventId: string,
): NostrEvent | undefined {
  return getNostrRequestContext(requestEventId);
}

/**
 * Removes a stored Nostr request context by inbound request event id.
 *
 * @param requestEventId The inbound signed Nostr request event id.
 */
export function deleteNostrRequestContext(requestEventId: string): void {
  nostrRequestContexts.delete(requestEventId);
}
