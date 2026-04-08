import { describe, expect, test } from 'bun:test';
import type { Filter, NostrEvent } from 'nostr-tools';
import { EncryptionMode, GiftWrapMode } from '../../core/interfaces.js';
import {
  AnnouncementManager,
  type AnnouncementManagerOptions,
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

describe('AnnouncementManager relay publication', () => {
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
});
