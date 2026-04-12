import { NOSTR_TAGS } from '../core/constants.js';
import { NostrEvent } from 'nostr-tools';

const NON_DISCOVERY_TAG_NAMES = new Set<string>(['e', 'p']);

/**
 * Parsed capability flags discovered from peer discovery tags.
 */
export interface DiscoveredPeerCapabilities {
  discoveryTags: string[][];
  supportsEncryption: boolean;
  supportsEphemeralEncryption: boolean;
  supportsOversizedTransfer: boolean;
}

/**
 * Capability flags learned from inbound peer discovery tags.
 */
export interface PeerCapabilities {
  supportsEncryption: boolean;
  supportsEphemeralEncryption: boolean;
  supportsOversizedTransfer: boolean;
}

function cloneTag(tag: readonly string[]): string[] {
  return [...tag];
}

/**
 * Returns true when a single-valued tag is present (e.g. ['support_oversized_transfer']).
 */
export function hasSingleTag(
  tags: readonly (readonly string[])[],
  tag: string,
): boolean {
  return tags.some((t) => t.length === 1 && t[0] === tag);
}

/**
 * Returns true when an event contains the provided single-valued tag.
 */
export function hasEventTag(
  event: NostrEvent | undefined,
  tag: string,
): boolean {
  return Array.isArray(event?.tags) && hasSingleTag(event.tags, tag);
}

/**
 * Returns cloned discovery tags by filtering out routing tags ('e', 'p').
 */
export function getDiscoveryTags(tags: readonly string[][]): string[][] {
  return tags
    .filter((tag) => {
      const tagName = tag[0];
      return (
        typeof tagName === 'string' && !NON_DISCOVERY_TAG_NAMES.has(tagName)
      );
    })
    .map((tag) => cloneTag(tag));
}

/**
 * Parses peer discovery tags into normalized capability flags.
 */
export function parseDiscoveredPeerCapabilities(
  tags: readonly string[][],
): DiscoveredPeerCapabilities {
  const discoveryTags = getDiscoveryTags(tags);
  const capabilities = learnPeerCapabilities(discoveryTags);

  return {
    discoveryTags,
    ...capabilities,
  };
}

/**
 * Inspects inbound tags and returns discovered peer capabilities.
 */
export function learnPeerCapabilities(
  eventTags: readonly (readonly string[])[],
): PeerCapabilities {
  return {
    supportsEncryption: hasSingleTag(eventTags, NOSTR_TAGS.SUPPORT_ENCRYPTION),
    supportsEphemeralEncryption: hasSingleTag(
      eventTags,
      NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
    ),
    supportsOversizedTransfer: hasSingleTag(
      eventTags,
      NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER,
    ),
  };
}

/**
 * Merges incoming discovery tags into current tags while preserving order and uniqueness.
 */
export function mergeDiscoveryTags(
  currentTags: readonly string[][],
  incomingTags: readonly string[][],
): string[][] {
  const mergedTags: string[][] = currentTags.map((tag) => cloneTag(tag));
  const seen = new Set<string>(mergedTags.map((tag) => JSON.stringify(tag)));

  for (const tag of incomingTags) {
    const key = JSON.stringify(tag);
    if (seen.has(key)) {
      continue;
    }
    mergedTags.push(cloneTag(tag));
    seen.add(key);
  }

  return mergedTags;
}
