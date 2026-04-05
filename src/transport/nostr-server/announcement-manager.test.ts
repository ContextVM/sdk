import { describe, test, expect } from 'bun:test';
import { AnnouncementManager } from './announcement-manager.js';
import { EncryptionMode, GiftWrapMode } from '../../core/interfaces.js';

describe('AnnouncementManager', () => {
  describe('CEP-15 schemaHash enrichment', () => {
    test('publishAnnouncementEvent enriches tools/list with schemaHash', async () => {
      const publishedEvents: any[] = [];

      const manager = new AnnouncementManager({
        encryptionMode: EncryptionMode.OPTIONAL,
        giftWrapMode: GiftWrapMode.OPTIONAL,
        onDispatchMessage: () => {},
        onPublishEvent: async (event) => publishedEvents.push(event),
        onSignEvent: async (template) => ({
          ...template,
          id: 'mock-event-id',
          sig: 'mock-sig',
        }),
        onGetPublicKey: async () => 'mock-pubkey',
        onSubscribe: async () => {},
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      });

      const toolsListResult = {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
            },
          },
        ],
      };

      // Access private method via any cast for testing
      await (manager as any).publishAnnouncementEvent(toolsListResult);

      expect(publishedEvents.length).toBeGreaterThan(0);
      const publishedEvent = publishedEvents.find(
        (e) => e.kind === 11317,
      ); // TOOLS_LIST_KIND

      expect(publishedEvent).toBeDefined();

      const content = JSON.parse(publishedEvent.content);
      expect(
        content.tools[0]._meta['io.contextvm/common-schema'].schemaHash,
      ).toBeDefined();
      expect(
        content.tools[0]._meta['io.contextvm/common-schema'].schemaHash,
      ).toHaveLength(64);
    });

    test('schemaHash is consistent between multiple enrichments', async () => {
      const publishedEvents: any[] = [];

      const manager = new AnnouncementManager({
        encryptionMode: EncryptionMode.OPTIONAL,
        giftWrapMode: GiftWrapMode.OPTIONAL,
        onDispatchMessage: () => {},
        onPublishEvent: async (event) => publishedEvents.push(event),
        onSignEvent: async (template) => ({
          ...template,
          id: 'mock-event-id',
          sig: 'mock-sig',
        }),
        onGetPublicKey: async () => 'mock-pubkey',
        onSubscribe: async () => {},
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      });

      const toolsListResult = {
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
              },
            },
          },
        ],
      };

      await (manager as any).publishAnnouncementEvent(toolsListResult);
      await (manager as any).publishAnnouncementEvent(toolsListResult);

      const event1 = publishedEvents[0];
      const event2 = publishedEvents[1];

      const content1 = JSON.parse(event1.content);
      const content2 = JSON.parse(event2.content);

      // Same input schema should produce identical schemaHash
      expect(
        content1.tools[0]._meta['io.contextvm/common-schema'].schemaHash,
      ).toBe(
        content2.tools[0]._meta['io.contextvm/common-schema'].schemaHash,
      );
    });

    test('non-tools/list results are not modified', async () => {
      const publishedEvents: any[] = [];

      const manager = new AnnouncementManager({
        encryptionMode: EncryptionMode.OPTIONAL,
        giftWrapMode: GiftWrapMode.OPTIONAL,
        onDispatchMessage: () => {},
        onPublishEvent: async (event) => publishedEvents.push(event),
        onSignEvent: async (template) => ({
          ...template,
          id: 'mock-event-id',
          sig: 'mock-sig',
        }),
        onGetPublicKey: async () => 'mock-pubkey',
        onSubscribe: async () => {},
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      });

      const resourcesListResult = {
        resources: [
          {
            uri: 'resource://test',
            name: 'Test Resource',
          },
        ],
      };

      await (manager as any).publishAnnouncementEvent(resourcesListResult);

      const publishedEvent = publishedEvents.find(
        (e) => e.kind === 11318,
      ); // RESOURCES_LIST_KIND

      expect(publishedEvent).toBeDefined();

      const content = JSON.parse(publishedEvent.content);
      // Resources should not have _meta injected
      expect(content.resources[0]._meta).toBeUndefined();
    });
  });
});
