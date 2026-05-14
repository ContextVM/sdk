import { type InitializeResult, InitializeResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { type NostrEvent } from 'nostr-tools';
import { NOSTR_TAGS } from '../../core/constants.js';
import { getNostrEventTag } from '../../core/utils/serializers.js';
import { queryTags } from '../../core/utils/utils.js';

export type ListEnvelopeType = 'tools' | 'resources' | 'templates' | 'prompts';

/**
 * Stores server discovery metadata learned by the client transport.
 */
export class ServerMetadataStore {
  private serverInitializeEvent: NostrEvent | undefined;
  private serverToolsListEvent: NostrEvent | undefined;
  private serverPromptsListEvent: NostrEvent | undefined;
  private serverResourcesListEvent: NostrEvent | undefined;
  private serverResourceTemplatesListEvent: NostrEvent | undefined;
  private supportsOversizedTransfer = false;
  private supportsOpenStream = false;

  public clear(): void {
    this.serverInitializeEvent = undefined;
    this.serverToolsListEvent = undefined;
    this.serverPromptsListEvent = undefined;
    this.serverResourcesListEvent = undefined;
    this.serverResourceTemplatesListEvent = undefined;
    this.supportsOversizedTransfer = false;
    this.supportsOpenStream = false;
  }

  public setServerInitializeEvent(event: NostrEvent): void {
    this.serverInitializeEvent = event;
  }

  public getServerInitializeEvent(): NostrEvent | undefined {
    return this.serverInitializeEvent;
  }

  public setSupportsOversizedTransfer(supported: boolean): void {
    this.supportsOversizedTransfer ||= supported;
  }

  public setSupportsOpenStream(supported: boolean): void {
    this.supportsOpenStream ||= supported;
  }

  public getServerSupportsOversizedTransfer(): boolean {
    return this.supportsOversizedTransfer;
  }

  public getServerSupportsOpenStream(): boolean {
    return this.supportsOpenStream;
  }

  public updateListEnvelopeState(type: ListEnvelopeType, event: NostrEvent): void {
    switch (type) {
      case 'tools':
        this.serverToolsListEvent = event;
        break;
      case 'resources':
        this.serverResourcesListEvent = event;
        break;
      case 'templates':
        this.serverResourceTemplatesListEvent = event;
        break;
      case 'prompts':
        this.serverPromptsListEvent = event;
        break;
      default:
        break;
    }
  }

  public getServerToolsListEvent(): NostrEvent | undefined {
    return this.serverToolsListEvent;
  }

  public getServerResourcesListEvent(): NostrEvent | undefined {
    return this.serverResourcesListEvent;
  }

  public getServerResourceTemplatesListEvent(): NostrEvent | undefined {
    return this.serverResourceTemplatesListEvent;
  }

  public getServerPromptsListEvent(): NostrEvent | undefined {
    return this.serverPromptsListEvent;
  }

  public getServerInitializeResult(): InitializeResult | undefined {
    if (!this.serverInitializeEvent) {
      return undefined;
    }

    try {
      const content = JSON.parse(this.serverInitializeEvent.content) as {
        result?: unknown;
      };
      const parse = InitializeResultSchema.safeParse(content.result);
      return parse.success ? parse.data : undefined;
    } catch {
      return undefined;
    }
  }

  public serverSupportsEncryption(): boolean {
    return queryTags(this.serverInitializeEvent, NOSTR_TAGS.SUPPORT_ENCRYPTION)
      .isFlag;
  }

  public serverSupportsEphemeralEncryption(): boolean {
    return queryTags(
      this.serverInitializeEvent,
      NOSTR_TAGS.SUPPORT_ENCRYPTION_EPHEMERAL,
    ).isFlag;
  }

  public getServerInitializeName(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.NAME,
    );
  }

  public getServerInitializeAbout(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.ABOUT,
    );
  }

  public getServerInitializeWebsite(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.WEBSITE,
    );
  }

  public getServerInitializePicture(): string | undefined {
    return getNostrEventTag(
      this.serverInitializeEvent?.tags ?? [],
      NOSTR_TAGS.PICTURE,
    );
  }
}
