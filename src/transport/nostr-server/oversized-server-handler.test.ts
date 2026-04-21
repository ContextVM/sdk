import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { NostrEvent } from 'nostr-tools';
import type { Logger } from '../../core/utils/logger.js';
import {
  sendAcceptFrame,
  sendOversizedServerResponse,
} from './oversized-server-handler.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

describe('oversized server handler', () => {
  test('sends an accept progress notification for oversized request starts', async () => {
    const sentNotifications: Array<{
      clientPubkey: string;
      notification: JSONRPCMessage;
    }> = [];

    await sendAcceptFrame(
      {
        clientPubkey: 'c'.repeat(64),
        progressToken: 'accept-token',
      },
      {
        sendNotification: async (
          clientPubkey: string,
          notification: JSONRPCMessage,
        ): Promise<void> => {
          sentNotifications.push({ clientPubkey, notification });
        },
      },
    );

    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0]).toEqual({
      clientPubkey: 'c'.repeat(64),
      notification: {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: 'accept-token',
          progress: 2,
          message: 'oversized request accepted',
          cvm: {
            type: 'oversized-transfer',
            frameType: 'accept',
          },
        },
      },
    });
  });

  test('publishes start, chunk, and end frames using the correct tag sets', async () => {
    const publishedFrames: Array<{
      frameType: string;
      tags: string[][] | undefined;
      recipientPublicKey: string;
      isEncrypted: boolean | undefined;
      giftWrapKind: number | undefined;
    }> = [];

    await sendOversizedServerResponse(
      {
        serialized: 'abcdefgh',
        clientPubkey: 'c'.repeat(64),
        progressToken: 'server-token',
        startFrameTags: [['e', 'start-event'], ['support_oversized_transfer']],
        continuationFrameTags: [['e', 'start-event']],
        isEncrypted: true,
        giftWrapKind: 1060,
      },
      {
        chunkSizeBytes: 4,
      },
      {
        sendMcpMessage: async (
          message: JSONRPCMessage,
          recipientPublicKey: string,
          _kind: number,
          tags?: NostrEvent['tags'],
          isEncrypted?: boolean,
          _onEventCreated?: (eventId: string) => void,
          giftWrapKind?: number,
        ): Promise<string> => {
          publishedFrames.push({
            frameType: String(
              (message as { params?: { cvm?: { frameType?: string } } }).params
                ?.cvm?.frameType,
            ),
            tags: tags?.map((tag) => [...tag]),
            recipientPublicKey,
            isEncrypted,
            giftWrapKind,
          });
          return `event-${publishedFrames.length}`;
        },
        logger: testLogger,
      },
    );

    expect(publishedFrames.map((frame) => frame.frameType)).toEqual([
      'start',
      'chunk',
      'chunk',
      'end',
    ]);
    expect(publishedFrames[0]?.tags).toEqual([
      ['e', 'start-event'],
      ['support_oversized_transfer'],
    ]);
    expect(publishedFrames[1]?.tags).toEqual([['e', 'start-event']]);
    expect(publishedFrames[2]?.tags).toEqual([['e', 'start-event']]);
    expect(publishedFrames[3]?.tags).toEqual([['e', 'start-event']]);
    expect(
      publishedFrames.every(
        (frame) =>
          frame.recipientPublicKey === 'c'.repeat(64) &&
          frame.isEncrypted === true &&
          frame.giftWrapKind === 1060,
      ),
    ).toBe(true);
  });
});
