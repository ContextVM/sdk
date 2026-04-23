import { describe, expect, test } from 'bun:test';
import type { Filter, NostrEvent } from 'nostr-tools';
import {
  PROFILE_METADATA_KIND,
  SERVER_ANNOUNCEMENT_KIND,
  TOOLS_LIST_KIND,
} from '../../core/constants.js';
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

describe('AnnouncementManager', () => {
  describe('publishRelayList', () => {
    test('does not append default bootstrap relays for local operational relays', async () => {
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

    test('keeps explicit bootstrap relays even for local operational relays', async () => {
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

    test('falls back to onPublishEvent for non-websocket relay targets', async () => {
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

    test('skips publication when option is false', async () => {
      let publishCalled = false;
      const manager = new AnnouncementManager(
        createBaseOptions({
          publishRelayList: false,
          onGetRelayUrls: () => ['ws://127.0.0.1:8080'],
          onPublishEvent: async () => {
            publishCalled = true;
          },
          onPublishEventToRelays: async () => {
            publishCalled = true;
          },
        }),
      );
      await manager.publishRelayList();
      expect(publishCalled).toBe(false);
    });

    test('skips gracefully when announcement event has no relays configured', async () => {
      let publishCalled = false;
      const manager = new AnnouncementManager(
        createBaseOptions({
          publishRelayList: true,
          relayListUrls: [], // No explicit relays
          bootstrapRelayUrls: [],
          onGetRelayUrls: () => [], // No operational relays
          onPublishEvent: async () => {
            publishCalled = true;
          },
          onPublishEventToRelays: async () => {
            publishCalled = true;
          },
        }),
      );

      await manager.publishRelayList();
      expect(publishCalled).toBe(false);
    });
  });

  describe('publishProfileMetadata', () => {
    test('produces a valid kind:0 event', async () => {
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

    test('skips publication when profileMetadata is not configured', async () => {
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

    test('preserves all optional and custom fields through JSON serialization', async () => {
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

    test('logs publication errors and does not throw', async () => {
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
      expect(loggedErrors[0]!.message).toBe(
        'Error publishing profile metadata',
      );
    });
  });

  describe('publishPublicAnnouncements', () => {
    test('dispatches initialize request and subsequently publishes announcement events', async () => {
      let publishedEventCount = 0;
      const manager = new AnnouncementManager(
        createBaseOptions({
          onPublishEvent: async () => {
            publishedEventCount++;
          },
          onDispatchMessage: (msg) => {
            // Simulate the MCP server responding synchronously to trigger the promise resolution
            if ('method' in msg && msg.method === 'initialize') {
              setTimeout(() => {
                manager.handleAnnouncementResponse({
                  jsonrpc: '2.0',
                  id: 'announcement',
                  result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    serverInfo: { name: 'Test', version: '1' },
                  },
                });
              }, 10);
            }
          },
        }),
      );

      await manager.publishPublicAnnouncements();

      // Because publishPublicAnnouncements awaits the internal initialization and then triggers
      // requests for tools, resources, etc., the initial initialize response will trigger at least 1 publish
      expect(publishedEventCount).toBeGreaterThan(0);
    });
  });

  describe('handleAnnouncementResponse', () => {
    test('publishes SERVER_ANNOUNCEMENT_KIND with correct tags for initialize result', async () => {
      let publishedEvent: NostrEvent | undefined;
      const manager = new AnnouncementManager(
        createBaseOptions({
          onPublishEvent: async (event) => {
            publishedEvent = event;
          },
          encryptionMode: EncryptionMode.DISABLED, // no extra tags
        }),
      );

      const initResult = {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'Test Server', version: '1.0' },
      };

      const handled = await manager.handleAnnouncementResponse({
        jsonrpc: '2.0',
        id: 'announcement',
        result: initResult,
      });

      expect(handled).toBe(true);
      expect(publishedEvent).toBeDefined();
      expect(publishedEvent!.kind).toBe(SERVER_ANNOUNCEMENT_KIND);
      expect(publishedEvent!.content).toBe(JSON.stringify(initResult));
    });

    test('maps ListToolsResultSchema correctly to TOOLS_LIST_KIND', async () => {
      let publishedEvent: NostrEvent | undefined;
      const manager = new AnnouncementManager(
        createBaseOptions({
          onPublishEvent: async (event) => {
            publishedEvent = event;
          },
        }),
      );

      const toolsResult = {
        tools: [
          {
            name: 'test_tool',
            description: 'A tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      };
      await manager.handleAnnouncementResponse({
        jsonrpc: '2.0',
        id: 'announcement',
        result: toolsResult,
      });

      expect(publishedEvent).toBeDefined();
      expect(publishedEvent!.kind).toBe(TOOLS_LIST_KIND);
      expect(publishedEvent!.content).toBe(JSON.stringify(toolsResult));
    });

    test('empty tools list is mapped and published successfully', async () => {
      let publishedEvent: NostrEvent | undefined;
      const manager = new AnnouncementManager(
        createBaseOptions({
          onPublishEvent: async (event) => {
            publishedEvent = event;
          },
        }),
      );

      await manager.handleAnnouncementResponse({
        jsonrpc: '2.0',
        id: 'announcement',
        result: { tools: [] },
      });

      expect(publishedEvent).toBeDefined();
      expect(publishedEvent!.kind).toBe(TOOLS_LIST_KIND);
      expect(JSON.parse(publishedEvent!.content).tools).toEqual([]);
    });
  });

  describe('getCapabilityTags', () => {
    test('includes support_encryption_ephemeral tag when GiftWrapMode is EPHEMERAL', () => {
      const ephemeralManager = new AnnouncementManager(
        createBaseOptions({
          encryptionMode: EncryptionMode.OPTIONAL,
          giftWrapMode: GiftWrapMode.EPHEMERAL,
        }),
      );
      const ephemeralTags = ephemeralManager.getCapabilityTags();
      expect(ephemeralTags).toContainEqual(['support_encryption']);
      expect(ephemeralTags).toContainEqual(['support_encryption_ephemeral']);
    });

    test('excludes support_encryption_ephemeral tag when GiftWrapMode is PERSISTENT', () => {
      const persistentManager = new AnnouncementManager(
        createBaseOptions({
          encryptionMode: EncryptionMode.OPTIONAL,
          giftWrapMode: GiftWrapMode.PERSISTENT,
        }),
      );
      const persistentTags = persistentManager.getCapabilityTags();
      expect(persistentTags).toContainEqual(['support_encryption']);
      expect(
        persistentTags.some((t) => t[0] === 'support_encryption_ephemeral'),
      ).toBe(false);
    });
  });

  describe('setExtraCommonTags / setPricingTags', () => {
    test('custom tags appear in announcement events', async () => {
      let publishedEvent: NostrEvent | undefined;
      const manager = new AnnouncementManager(
        createBaseOptions({
          onPublishEvent: async (event) => {
            publishedEvent = event;
          },
        }),
      );

      manager.setExtraCommonTags([['custom_tag', 'value']]);

      await manager.handleAnnouncementResponse({
        jsonrpc: '2.0',
        id: 'announcement',
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'Test', version: '1' },
        },
      });

      expect(publishedEvent).toBeDefined();
      expect(publishedEvent!.tags).toContainEqual(['custom_tag', 'value']);
    });

    test('CEP-8 pricing tag attachment (setPricingTags)', async () => {
      let publishedEvent: NostrEvent | undefined;
      const manager = new AnnouncementManager(
        createBaseOptions({
          onPublishEvent: async (event) => {
            publishedEvent = event;
          },
        }),
      );

      manager.setPricingTags([['cap', 'test_tool', 'msat', '1000']]);

      await manager.handleAnnouncementResponse({
        jsonrpc: '2.0',
        id: 'announcement',
        result: { tools: [] },
      });

      expect(publishedEvent).toBeDefined();
      expect(publishedEvent!.tags).toContainEqual([
        'cap',
        'test_tool',
        'msat',
        '1000',
      ]);
    });
  });
});
