import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sleep } from 'bun';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { createLogger } from '../core/utils/logger.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { NostrMCPGateway } from './index.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import {
  SERVER_ANNOUNCEMENT_KIND,
  TOOLS_LIST_KIND,
  RESOURCES_LIST_KIND,
  RESOURCETEMPLATES_LIST_KIND,
  PROMPTS_LIST_KIND,
} from '../core/index.js';

/**
 * A mock MCP transport that responds to announcement introspection messages.
 * Mimics an MCP server that returns empty capability lists.
 */
class MockAnnouncementTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  async start(): Promise<void> {}
  async close(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (!('method' in message)) {
      return;
    }

    const method = (message as { method?: unknown }).method;
    const id = (message as { id?: string | number }).id!;

    switch (method) {
      case 'initialize': {
        queueMicrotask(() => {
          this.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'TestAnnounce', version: '1.0.0' },
            },
          });
        });
        break;
      }
      case 'tools/list': {
        queueMicrotask(() => {
          this.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: { tools: [] },
          });
        });
        break;
      }
      case 'resources/list': {
        queueMicrotask(() => {
          this.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: { resources: [] },
          });
        });
        break;
      }
      case 'resources/templates/list': {
        queueMicrotask(() => {
          this.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: { resourceTemplates: [] },
          });
        });
        break;
      }
      case 'prompts/list': {
        queueMicrotask(() => {
          this.onmessage?.({
            jsonrpc: '2.0',
            id,
            result: { prompts: [] },
          });
        });
        break;
      }
      case 'notifications/initialized':
        break;
      default:
        break;
    }
  }
}

describe('NostrMCPGateway announcement transport in per-client mode', () => {
  let relayHub: MockRelayHub;
  const logger = createLogger('gateway-announcement-test');

  const gatewayPrivateKey = bytesToHex(generateSecretKey());
  const gatewayPublicKey = getPublicKey(hexToBytes(gatewayPrivateKey));

  beforeAll(async () => {
    relayHub = new MockRelayHub();
    logger.info('Relay started', {
      relayUrl: 'memory://relay',
      gatewayPublicKey,
    });
  });

  afterAll(async () => {
    relayHub.clear();
    await sleep(100);
  });

  test('should publish announcement events when announcementMcpTransport is provided', async () => {
    const gatewaySigner = new PrivateKeySigner(gatewayPrivateKey);
    const gatewayRelayHandler = relayHub.createRelayHandler();

    const announcementTransport = new MockAnnouncementTransport();
    const perClientSentMessages: JSONRPCMessage[] = [];

    const gateway = new NostrMCPGateway({
      createMcpClientTransport: () => {
        const t: Transport = {
          start: async () => {},
          close: async () => {},
          send: async (message: JSONRPCMessage) => {
            perClientSentMessages.push(message);
          },
          onmessage: undefined,
          onerror: undefined,
          onclose: undefined,
        };
        return t;
      },
      announcementMcpTransport: announcementTransport,
      nostrTransportOptions: {
        signer: gatewaySigner,
        relayHandler: gatewayRelayHandler,
        isAnnouncedServer: true,
        publishRelayList: false,
        serverInfo: {
          name: 'Test Server',
          website: 'http://localhost',
        },
      },
    });

    await gateway.start();
    // Allow queued microtasks and async publishes to complete.
    await sleep(300);

    const events = relayHub.getEvents();

    // Per-client transports must not receive announcement messages.
    const hasAnnouncementInPerClient = perClientSentMessages.some(
      (m) =>
        ('id' in m && (m as { id?: unknown }).id === 'announcement') ||
        ('method' in m &&
          (m as { method?: unknown }).method === 'notifications/initialized'),
    );
    expect(hasAnnouncementInPerClient).toBe(false);

    // Announcement events should have been published.
    const serverAnnouncement = events.find(
      (e) => e.kind === SERVER_ANNOUNCEMENT_KIND,
    );
    expect(serverAnnouncement).toBeDefined();
    expect(serverAnnouncement?.pubkey).toBe(gatewayPublicKey);

    const toolsAnnouncement = events.find((e) => e.kind === TOOLS_LIST_KIND);
    expect(toolsAnnouncement).toBeDefined();

    const resourcesAnnouncement = events.find(
      (e) => e.kind === RESOURCES_LIST_KIND,
    );
    expect(resourcesAnnouncement).toBeDefined();

    const resourceTemplatesAnnouncement = events.find(
      (e) => e.kind === RESOURCETEMPLATES_LIST_KIND,
    );
    expect(resourceTemplatesAnnouncement).toBeDefined();

    const promptsAnnouncement = events.find(
      (e) => e.kind === PROMPTS_LIST_KIND,
    );
    expect(promptsAnnouncement).toBeDefined();

    await gateway.stop();
  }, 15000);

  test('should not publish announcement events without announcementMcpTransport in per-client mode', async () => {
    // Use a fresh relay hub so events from the previous test don't leak.
    const freshRelayHub = new MockRelayHub();
    const gatewaySigner = new PrivateKeySigner(gatewayPrivateKey);
    const gatewayRelayHandler = freshRelayHub.createRelayHandler();

    const gateway = new NostrMCPGateway({
      createMcpClientTransport: () => ({
        start: async () => {},
        close: async () => {},
        send: async () => {},
        onmessage: undefined,
        onerror: undefined,
        onclose: undefined,
      }),
      nostrTransportOptions: {
        signer: gatewaySigner,
        relayHandler: gatewayRelayHandler,
        isAnnouncedServer: true,
        publishRelayList: false,
      },
    });

    await gateway.start();
    await sleep(300);

    const events = freshRelayHub.getEvents();
    const serverAnnouncement = events.find(
      (e) => e.kind === SERVER_ANNOUNCEMENT_KIND,
    );
    expect(serverAnnouncement).toBeUndefined();

    await gateway.stop();
    freshRelayHub.clear();
  }, 15000);

  test('should start and close the dedicated announcement transport during gateway lifecycle', async () => {
    const freshRelayHub = new MockRelayHub();
    const gatewaySigner = new PrivateKeySigner(gatewayPrivateKey);
    const gatewayRelayHandler = freshRelayHub.createRelayHandler();

    let startCount = 0;
    let closeCount = 0;

    const mockAnnouncementTransport: Transport = {
      start: async () => {
        startCount += 1;
      },
      close: async () => {
        closeCount += 1;
      },
      send: async () => {},
      onmessage: undefined,
      onerror: undefined,
      onclose: undefined,
    };

    const gateway = new NostrMCPGateway({
      createMcpClientTransport: () => ({
        start: async () => {},
        close: async () => {},
        send: async () => {},
        onmessage: undefined,
        onerror: undefined,
        onclose: undefined,
      }),
      announcementMcpTransport: mockAnnouncementTransport,
      nostrTransportOptions: {
        signer: gatewaySigner,
        relayHandler: gatewayRelayHandler,
        isAnnouncedServer: false,
        publishRelayList: false,
      },
    });

    expect(startCount).toBe(0);
    expect(closeCount).toBe(0);

    await gateway.start();
    expect(startCount).toBe(1);
    expect(closeCount).toBe(0);

    await gateway.stop();
    expect(startCount).toBe(1);
    expect(closeCount).toBe(1);

    freshRelayHub.clear();
  }, 15000);
});
