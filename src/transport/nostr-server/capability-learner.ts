import { NOSTR_TAGS } from '../../core/constants.js';
import { hasSingleTag } from '../discovery-tags.js';

/**
 * Capability flags learned from inbound peer discovery tags.
 */
export interface PeerCapabilities {
  supportsEncryption: boolean;
  supportsEphemeralEncryption: boolean;
  supportsOversizedTransfer: boolean;
}

/**
 * Inspects inbound tags and returns discovered client capabilities.
 */
export function learnPeerCapabilities(
  eventTags: readonly (readonly string[])[],
  oversizedEnabled: boolean,
): PeerCapabilities {
  const supportsOversizedTransfer = oversizedEnabled
    ? hasSingleTag(eventTags, NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER)
    : false;

  return {
    supportsEncryption: hasSingleTag(eventTags, NOSTR_TAGS.SUPPORT_ENCRYPTION),
    supportsEphemeralEncryption: hasSingleTag(
      eventTags,
      NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
    ),
    supportsOversizedTransfer,
  };
}
