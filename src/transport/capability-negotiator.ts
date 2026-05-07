import { NOSTR_TAGS, EPHEMERAL_GIFT_WRAP_KIND, GIFT_WRAP_KIND } from '../core/constants.js';
import { EncryptionMode, GiftWrapMode } from '../core/interfaces.js';
import { type NostrEvent } from 'nostr-tools';
import { type ClientSession } from './nostr-server/session-store.js';
import { queryTags } from '../core/utils/utils.js';

const NON_DISCOVERY_TAG_NAMES = new Set<string>(['e', 'p']);

export interface DiscoveredPeerCapabilities {
  discoveryTags: string[][];
  supportsEncryption: boolean;
  supportsEphemeralEncryption: boolean;
  supportsOversizedTransfer: boolean;
  supportsOpenStream: boolean;
}

export interface PeerCapabilities {
  supportsEncryption: boolean;
  supportsEphemeralEncryption: boolean;
  supportsOversizedTransfer: boolean;
  supportsOpenStream: boolean;
}

function cloneTag(tag: readonly string[]): string[] {
  return [...tag];
}

export function hasSingleTag(
  tags: readonly (readonly string[])[],
  tag: string,
): boolean {
  return tags.some((t) => t.length === 1 && t[0] === tag);
}

export function hasEventTag(
  event: NostrEvent | undefined,
  tag: string,
): boolean {
  return Array.isArray(event?.tags) && hasSingleTag(event.tags, tag);
}

export function getDiscoveryTags(tags: readonly string[][]): string[][] {
  return tags
    .filter((tag) => {
      const tagName = tag[0];
      return typeof tagName === 'string' && !NON_DISCOVERY_TAG_NAMES.has(tagName);
    })
    .map((tag) => cloneTag(tag));
}

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

export function learnPeerCapabilities(
  eventTags: readonly (readonly string[])[],
): PeerCapabilities {
  return {
    supportsEncryption: hasSingleTag(eventTags, NOSTR_TAGS.SUPPORT_ENCRYPTION),
    supportsEphemeralEncryption: hasSingleTag(eventTags, NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL),
    supportsOversizedTransfer: hasSingleTag(eventTags, NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER),
    supportsOpenStream: hasSingleTag(eventTags, NOSTR_TAGS.SUPPORT_OPEN_STREAM),
  };
}

export class ServerCapabilityNegotiator {
  constructor(
    private deps: {
      getCommonTags: () => string[][];
      composeOutboundTags: (params: {
        baseTags: readonly string[][];
        discoveryTags: readonly string[][];
        negotiationTags: readonly string[][];
      }) => string[][];
      giftWrapMode: GiftWrapMode;
    },
  ) {}

  public takePendingDiscoveryTags(session: ClientSession): string[][] {
    if (session.hasSentCommonTags) {
      return [];
    }
    session.hasSentCommonTags = true;
    return this.deps.getCommonTags();
  }

  public buildOutboundTags(params: {
    baseTags: readonly string[][];
    session: ClientSession;
    includeDiscovery?: boolean;
    negotiationTags?: readonly string[][];
  }): string[][] {
    const { baseTags, session, includeDiscovery = true, negotiationTags = [] } = params;
    return this.deps.composeOutboundTags({
      baseTags,
      discoveryTags: includeDiscovery ? this.takePendingDiscoveryTags(session) : [],
      negotiationTags,
    });
  }

  public chooseOutboundGiftWrapKind(params: {
    session: ClientSession;
    fallbackWrapKind?: number;
  }): number | undefined {
    const { session, fallbackWrapKind } = params;

    if (!session.isEncrypted) return undefined;
    if (this.deps.giftWrapMode === GiftWrapMode.EPHEMERAL) return EPHEMERAL_GIFT_WRAP_KIND;
    if (this.deps.giftWrapMode === GiftWrapMode.PERSISTENT) return GIFT_WRAP_KIND;
    if (session.supportsEphemeralEncryption) return EPHEMERAL_GIFT_WRAP_KIND;
    return fallbackWrapKind;
  }
}

export class ClientCapabilityNegotiator {
  private hasSentDiscoveryTags = false;
  private clientPmis?: readonly string[];
  private serverSupportsEphemeralGiftWraps = false;
  private _serverInitializeEvent?: NostrEvent;

  constructor(
    private deps: {
      encryptionMode: EncryptionMode;
      giftWrapMode: GiftWrapMode;
      oversizedEnabled: boolean;
      openStreamEnabled: boolean;
      composeOutboundTags: (params: {
        baseTags: readonly string[][];
        discoveryTags: readonly string[][];
        negotiationTags: readonly string[][];
      }) => string[][];
    },
  ) {}

  public setClientPmis(pmis: readonly string[]): void {
    this.clientPmis = pmis;
  }

  /**
   * Updates server capability flags from discovered peer tags.
   * Called by the transport when it learns new capabilities from inbound events.
   */
  public learnServerCapabilities(discovered: {
    supportsEphemeralEncryption: boolean;
  }): void {
    this.serverSupportsEphemeralGiftWraps ||= discovered.supportsEphemeralEncryption;
  }

  /**
   * Records the server's initialize event for gift-wrap kind negotiation.
   */
  public setServerInitializeEvent(event: NostrEvent): void {
    this._serverInitializeEvent = event;
  }

  public getCapabilityTags(): string[][] {
    const tags: string[][] = [];
    if (this.deps.encryptionMode !== EncryptionMode.DISABLED) {
      tags.push([NOSTR_TAGS.SUPPORT_ENCRYPTION]);
    }
    if (this.deps.encryptionMode !== EncryptionMode.DISABLED && this.deps.giftWrapMode !== GiftWrapMode.PERSISTENT) {
      tags.push([NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL]);
    }
    if (this.deps.oversizedEnabled) {
      tags.push([NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER]);
    }
    if (this.deps.openStreamEnabled) {
      tags.push([NOSTR_TAGS.SUPPORT_OPEN_STREAM]);
    }
    return tags;
  }

  public getNegotiationTags(): string[][] {
    const tags: string[][] = [];
    if (this.clientPmis) {
      tags.push(...this.clientPmis.map((pmi) => ['pmi', pmi]));
    }
    return tags;
  }

  public getPendingDiscoveryTags(): string[][] {
    return this.hasSentDiscoveryTags ? [] : this.getCapabilityTags();
  }

  public buildOutboundTags(params: {
    baseTags: readonly string[][];
    includeDiscovery: boolean;
  }): string[][] {
    const { baseTags, includeDiscovery } = params;
    return this.deps.composeOutboundTags({
      baseTags,
      discoveryTags: includeDiscovery ? this.getPendingDiscoveryTags() : [],
      negotiationTags: includeDiscovery ? this.getNegotiationTags() : [],
    });
  }

  public markDiscoveryTagsSent(): void {
    if (this.getPendingDiscoveryTags().length > 0) {
      this.hasSentDiscoveryTags = true;
    }
  }

  public chooseOutboundGiftWrapKind(): number {
    if (this.deps.giftWrapMode === GiftWrapMode.PERSISTENT) return GIFT_WRAP_KIND;
    if (this.deps.giftWrapMode === GiftWrapMode.EPHEMERAL) return EPHEMERAL_GIFT_WRAP_KIND;
    if (this.serverSupportsEphemeralGiftWraps) return EPHEMERAL_GIFT_WRAP_KIND;
    const supportsEphemeralFromInit = queryTags(
      this._serverInitializeEvent,
      NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
    ).isFlag;
    return supportsEphemeralFromInit ? EPHEMERAL_GIFT_WRAP_KIND : GIFT_WRAP_KIND;
  }
}
