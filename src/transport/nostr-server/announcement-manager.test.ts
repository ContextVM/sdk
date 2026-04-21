import { describe, expect, test } from 'bun:test';
import type { Filter, NostrEvent } from 'nostr-tools';
import { PROFILE_METADATA_KIND } from '../../core/constants.js';
import { EncryptionMode, GiftWrapMode } from '../../core/interfaces.js';
import {
  AnnouncementManager,
  type AnnouncementManagerOptions,
  type ProfileMetadata,
} from './announcement-manager.js';

const createBaseOptions = (
  overrides: Partial<AnnouncementManagerOptions> = {},
): AnnouncementManagerOptions => ({
  encryptionMode: EncryptionMode.DISABLED,
  giftWrapMode: GiftWrapMode.PERSISTENT,
  onDispatchMessage: () => undefined,
  onPublishEvent: async () => undefined,
  onSignEvent: async (eventTemplate) =>
    ({
      ...eventTemplate,
      id: 'signed-event-id',
      sig: 'signed-event-sig',
    }) as NostrEvent,
  onGetPublicKey: async () => 'server-pubkey',
  onSubscribe: async (
    _filters: Filter[],
    _onEvent: (event: NostrEvent) => void,
  ) => undefined,
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
  ...overrides,
});

describe('AnnouncementManager profile metadata publication', () => {
  test('publishRelayList() does not append default bootstrap relays for local operational relays', async () => {
    let publishedRelayUrls: string[] | undefined;

    const manager = new AnnouncementManager(
      createBaseOptions({
        onGetRelayUrls: () => ['ws://127.0.0.1:8080'],
        onPublishEventToRelays: async (_event, relayUrls) => {
          publishedRelayUrls = relayUrls;
        },
      }),
    );

    await manager.publishRelayList();

    expect(publishedRelayUrls).toEqual(['ws://127.0.0.1:8080']);
  });

  test('publishRelayList() keeps explicit bootstrap relays even for local operational relays', async () => {
    let publishedRelayUrls: string[] | undefined;

    const manager = new AnnouncementManager(
      createBaseOptions({
        onGetRelayUrls: () => ['ws://127.0.0.1:8080'],
        bootstrapRelayUrls: ['wss://bootstrap.example.com'],
        onPublishEventToRelays: async (_event, relayUrls) => {
          publishedRelayUrls = relayUrls;
        },
      }),
    );

    await manager.publishRelayList();

    expect(publishedRelayUrls).toEqual([
      'ws://127.0.0.1:8080',
      'wss://bootstrap.example.com',
    ]);
  });

  test('publishRelayList() falls back to onPublishEvent for non-websocket relay targets', async () => {
    let publishEventCalled = false;
    let publishEventToRelaysCalled = false;

    const manager = new AnnouncementManager(
      createBaseOptions({
        relayListUrls: ['memory://relay'],
        onPublishEvent: async () => {
          publishEventCalled = true;
        },
        onPublishEventToRelays: async () => {
          publishEventToRelaysCalled = true;
        },
      }),
    );

    await manager.publishRelayList();

    expect(publishEventCalled).toBe(true);
    expect(publishEventToRelaysCalled).toBe(false);
  });

  test('publishProfileMetadata() produces a valid kind:0 event', async () => {
    const profileMetadata: ProfileMetadata = {
      name: 'ContextVM Server',
      about: 'A public MCP server',
      website: 'https://contextvm.org',
      picture: 'https://example.com/avatar.png',
    };

    let signedTemplate: NostrEvent | undefined;
    let publishedEvent: NostrEvent | undefined;

    const manager = new AnnouncementManager(
      createBaseOptions({
        profileMetadata,
        onSignEvent: async (eventTemplate) => {
          signedTemplate = eventTemplate;
          return {
            ...eventTemplate,
            id: 'profile-event-id',
            sig: 'profile-event-sig',
          } as NostrEvent;
        },
        onPublishEvent: async (event) => {
          publishedEvent = event;
        },
      }),
    );

    await manager.publishProfileMetadata();

    expect(signedTemplate).toBeDefined();
    expect(signedTemplate!.kind).toBe(PROFILE_METADATA_KIND);
    expect(signedTemplate!.pubkey).toBe('server-pubkey');
    expect(signedTemplate!.tags).toEqual([]);
    expect(signedTemplate!.content).toBe(JSON.stringify(profileMetadata));

    expect(publishedEvent).toBeDefined();
    expect(publishedEvent!.kind).toBe(PROFILE_METADATA_KIND);
  });

  test('publishProfileMetadata() skips publication when profileMetadata is not configured', async () => {
    let signCalled = false;
    let publishCalled = false;

    const manager = new AnnouncementManager(
      createBaseOptions({
        onSignEvent: async (eventTemplate) => {
          signCalled = true;
          return {
            ...eventTemplate,
            id: 'unexpected-sign-id',
            sig: 'unexpected-sign-sig',
          } as NostrEvent;
        },
        onPublishEvent: async () => {
          publishCalled = true;
        },
      }),
    );

    await manager.publishProfileMetadata();

    expect(signCalled).toBe(false);
    expect(publishCalled).toBe(false);
  });

  test('publishProfileMetadata() preserves all optional and custom fields through JSON serialization', async () => {
    const profileMetadata: ProfileMetadata = {
      name: 'Profile Name',
      about: 'Profile About',
      picture: 'https://example.com/picture.png',
      banner: 'https://example.com/banner.png',
      website: 'https://example.com',
      nip05: 'server@example.com',
      lud16: 'tips@getalby.com',
      custom_flag: true,
      changelog_url: 'https://example.com/changelog',
    };

    let serializedContent = '';

    const manager = new AnnouncementManager(
      createBaseOptions({
        profileMetadata,
        onSignEvent: async (eventTemplate) => {
          serializedContent = eventTemplate.content;
          return {
            ...eventTemplate,
            id: 'roundtrip-event-id',
            sig: 'roundtrip-event-sig',
          } as NostrEvent;
        },
      }),
    );

    await manager.publishProfileMetadata();

    expect(JSON.parse(serializedContent)).toEqual(profileMetadata);
  });

  test('publishPublicAnnouncements() only requests announcement publication', async () => {
    const manager = new AnnouncementManager(
      createBaseOptions({
        profileMetadata: { name: 'Sequenced Profile' },
      }),
    );

    let requestCalled = false;
    let profileCalled = false;

    (
      manager as unknown as {
        requestAnnouncementPublication: () => Promise<void>;
      }
    ).requestAnnouncementPublication = async () => {
      requestCalled = true;
    };

    manager.publishProfileMetadata = async () => {
      profileCalled = true;
    };

    await manager.publishPublicAnnouncements();

    expect(requestCalled).toBe(true);
    expect(profileCalled).toBe(false);
  });

  test('publishProfileMetadata() logs publication errors and does not throw', async () => {
    const loggedErrors: Array<{ message: string; meta?: unknown }> = [];

    const manager = new AnnouncementManager(
      createBaseOptions({
        profileMetadata: { name: 'Failure Case Profile' },
        onSignEvent: async () => {
          throw new Error('sign failure');
        },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          debug: () => undefined,
          error: (message, meta) => {
            loggedErrors.push({ message, meta });
          },
        },
      }),
    );

    let threw = false;
    try {
      await manager.publishProfileMetadata();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(loggedErrors.length).toBe(1);
    expect(loggedErrors[0]!.message).toBe('Error publishing profile metadata');
  });
});
