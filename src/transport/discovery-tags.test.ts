import { describe, expect, test } from 'bun:test';
import type { NostrEvent } from 'nostr-tools';
import { NOSTR_TAGS } from '../core/constants.js';
import {
  getDiscoveryTags,
  hasEventTag,
  hasSingleTag,
  learnPeerCapabilities,
  mergeDiscoveryTags,
  parseDiscoveredPeerCapabilities,
} from './discovery-tags.js';

describe('Discovery Tags', () => {
  describe('hasSingleTag', () => {
    test('finds single-element tags', () => {
      const tags = [['a'], ['b'], [NOSTR_TAGS.SUPPORT_ENCRYPTION]];
      expect(hasSingleTag(tags, NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(true);
    });

    test('rejects multi-element tags', () => {
      const tags = [['a'], [NOSTR_TAGS.SUPPORT_ENCRYPTION, 'true']];
      expect(hasSingleTag(tags, NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(false);
    });

    test('returns false when tag is missing', () => {
      const tags = [['a'], ['b']];
      expect(hasSingleTag(tags, NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(false);
    });

    test('returns false for empty tags array', () => {
      expect(hasSingleTag([], NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(false);
    });
  });

  describe('hasEventTag', () => {
    test('returns true for valid event with tag', () => {
      const event = {
        tags: [[NOSTR_TAGS.SUPPORT_ENCRYPTION]],
      } as NostrEvent;
      expect(hasEventTag(event, NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(true);
    });

    test('returns false for valid event without tag', () => {
      const event = {
        tags: [['a']],
      } as NostrEvent;
      expect(hasEventTag(event, NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(false);
    });

    test('returns false for undefined event', () => {
      expect(hasEventTag(undefined, NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(false);
    });

    test('returns false for event with undefined tags', () => {
      const event = {} as NostrEvent;
      expect(hasEventTag(event, NOSTR_TAGS.SUPPORT_ENCRYPTION)).toBe(false);
    });
  });

  describe('getDiscoveryTags', () => {
    test('filters out routing tags and clones remaining tags', () => {
      const originalTags = [
        ['e', '123'],
        ['p', 'abc'],
        ['custom_tag', 'value'],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION],
      ];
      const result = getDiscoveryTags(originalTags);

      expect(result).toEqual([
        ['custom_tag', 'value'],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION],
      ]);

      // Verify cloning
      expect(result[0]).not.toBe(originalTags[2]);
      expect(result[1]).not.toBe(originalTags[3]);
    });

    test('returns empty array for empty input', () => {
      expect(getDiscoveryTags([])).toEqual([]);
    });

    test('allows unknown tag names to pass through', () => {
      const tags = [
        ['unknown', 'data'],
        ['x', 'y', 'z'],
      ];
      expect(getDiscoveryTags(tags)).toEqual([
        ['unknown', 'data'],
        ['x', 'y', 'z'],
      ]);
    });
  });

  describe('learnPeerCapabilities', () => {
    test('toggles flags independently based on tags', () => {
      const emptyCaps = learnPeerCapabilities([]);
      expect(emptyCaps.supportsEncryption).toBe(false);
      expect(emptyCaps.supportsEphemeralEncryption).toBe(false);
      expect(emptyCaps.supportsOversizedTransfer).toBe(false);

      const encCaps = learnPeerCapabilities([[NOSTR_TAGS.SUPPORT_ENCRYPTION]]);
      expect(encCaps.supportsEncryption).toBe(true);
      expect(encCaps.supportsEphemeralEncryption).toBe(false);
      expect(encCaps.supportsOversizedTransfer).toBe(false);

      const allCaps = learnPeerCapabilities([
        [NOSTR_TAGS.SUPPORT_ENCRYPTION],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL],
        [NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER],
      ]);
      expect(allCaps.supportsEncryption).toBe(true);
      expect(allCaps.supportsEphemeralEncryption).toBe(true);
      expect(allCaps.supportsOversizedTransfer).toBe(true);
    });
  });

  describe('parseDiscoveredPeerCapabilities', () => {
    test('performs full parse including filtering and capabilities extraction', () => {
      const tags = [
        ['e', '123'],
        [NOSTR_TAGS.SUPPORT_ENCRYPTION],
        ['custom_tag'],
        [NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER],
      ];

      const result = parseDiscoveredPeerCapabilities(tags);

      expect(result.discoveryTags).toEqual([
        [NOSTR_TAGS.SUPPORT_ENCRYPTION],
        ['custom_tag'],
        [NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER],
      ]);
      expect(result.supportsEncryption).toBe(true);
      expect(result.supportsEphemeralEncryption).toBe(false);
      expect(result.supportsOversizedTransfer).toBe(true);
    });
  });

  describe('mergeDiscoveryTags', () => {
    test('deduplicates tags, preserves order, and clones elements', () => {
      const currentTags = [
        ['a', '1'],
        ['b', '2'],
      ];
      const incomingTags = [
        ['b', '2'], // duplicate
        ['c', '3'],
        ['a', '1'], // duplicate
      ];

      const result = mergeDiscoveryTags(currentTags, incomingTags);

      expect(result).toEqual([
        ['a', '1'],
        ['b', '2'],
        ['c', '3'],
      ]);

      // Verify cloning
      expect(result[0]).not.toBe(currentTags[0]);
      expect(result[1]).not.toBe(currentTags[1]);
      expect(result[1]).not.toBe(incomingTags[0]);
      expect(result[2]).not.toBe(incomingTags[1]);
    });

    test('handles empty arrays', () => {
      expect(mergeDiscoveryTags([], [])).toEqual([]);
      expect(mergeDiscoveryTags([['a']], [])).toEqual([['a']]);
      expect(mergeDiscoveryTags([], [['b']])).toEqual([['b']]);
    });
  });
});
