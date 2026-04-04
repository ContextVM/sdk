import { NOSTR_TAGS } from '../core/constants.js';

const NON_DISCOVERY_TAG_NAMES = new Set<string>(['e', 'p']);

export interface DiscoveredPeerCapabilities {
  discoveryTags: string[][];
  supportsEncryption: boolean;
  supportsEphemeralEncryption: boolean;
  supportsOversizedTransfer: boolean;
}

function cloneTag(tag: readonly string[]): string[] {
  return [...tag];
}

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

export function hasDiscoveryTags(tags: readonly string[][]): boolean {
  return tags.some((tag) => {
    const tagName = tag[0];
    return typeof tagName === 'string' && !NON_DISCOVERY_TAG_NAMES.has(tagName);
  });
}

export function parseDiscoveredPeerCapabilities(
  tags: readonly string[][],
): DiscoveredPeerCapabilities {
  const discoveryTags = getDiscoveryTags(tags);

  return {
    discoveryTags,
    supportsEncryption: discoveryTags.some(
      (tag) => tag.length === 1 && tag[0] === NOSTR_TAGS.SUPPORT_ENCRYPTION,
    ),
    supportsEphemeralEncryption: discoveryTags.some(
      (tag) =>
        tag.length === 1 && tag[0] === NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
    ),
    supportsOversizedTransfer: discoveryTags.some(
      (tag) =>
        tag.length === 1 && tag[0] === NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER,
    ),
  };
}

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
