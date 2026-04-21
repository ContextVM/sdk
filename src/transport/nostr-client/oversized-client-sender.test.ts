import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { NostrEvent } from 'nostr-tools';
import type { Logger } from '../../core/utils/logger.js';
import { sendOversizedClientRequest } from './oversized-client-sender.js';

const testLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  withModule: () => testLogger,
};

describe('sendOversizedClientRequest', () => {
  test('waits for accept before publishing chunks when server support is not yet known', async () => {
    const publishedMethods: string[] = [];
    const acceptedTokens: string[] = [];

    const endEventId = await sendOversizedClientRequest(
      'abcdefgh',
      'token-accept',
      {
        chunkSizeBytes: 4,
        acceptTimeoutMs: 250,
        serverPubkey: 'b'.repeat(64),
        serverSupportsOversizedTransfer: false,
        giftWrapKind: 1059,
        startFrameTags: [['p', 'b'.repeat(64)], ['support_oversized_transfer']],
        continuationFrameTags: [['p', 'b'.repeat(64)]],
      },
      {
        sendMcpMessage: async (
          message: JSONRPCMessage,
          _recipientPublicKey: string,
          _kind: number,
          _tags?: NostrEvent['tags'],
          _isEncrypted?: boolean,
          _onEventCreated?: (eventId: string) => void,
          _giftWrapKind?: number,
        ): Promise<string> => {
          publishedMethods.push(
            String(
              (message as { params?: { cvm?: { frameType?: string } } }).params
                ?.cvm?.frameType,
            ),
          );
          return `event-${publishedMethods.length}`;
        },
        waitForAccept: async (token: string): Promise<void> => {
          acceptedTokens.push(token);
        },
        logger: testLogger,
      },
    );

    expect(publishedMethods).toEqual(['start', 'chunk', 'chunk', 'end']);
    expect(acceptedTokens).toEqual(['token-accept']);
    expect(endEventId).toBe('event-4');
  });

  test('publishes immediately without waiting for accept after server support is learned', async () => {
    const publishedMethods: string[] = [];
    let waitForAcceptCalls = 0;

    const endEventId = await sendOversizedClientRequest(
      'abcdefgh',
      'token-no-accept',
      {
        chunkSizeBytes: 4,
        acceptTimeoutMs: 250,
        serverPubkey: 'b'.repeat(64),
        serverSupportsOversizedTransfer: true,
        giftWrapKind: 1059,
        startFrameTags: [['p', 'b'.repeat(64)], ['support_oversized_transfer']],
        continuationFrameTags: [['p', 'b'.repeat(64)]],
      },
      {
        sendMcpMessage: async (
          message: JSONRPCMessage,
          _recipientPublicKey: string,
          _kind: number,
          _tags?: NostrEvent['tags'],
          _isEncrypted?: boolean,
          _onEventCreated?: (eventId: string) => void,
          _giftWrapKind?: number,
        ): Promise<string> => {
          publishedMethods.push(
            String(
              (message as { params?: { cvm?: { frameType?: string } } }).params
                ?.cvm?.frameType,
            ),
          );
          return `event-${publishedMethods.length}`;
        },
        waitForAccept: async (): Promise<void> => {
          waitForAcceptCalls += 1;
        },
        logger: testLogger,
      },
    );

    expect(publishedMethods).toEqual(['start', 'chunk', 'chunk', 'end']);
    expect(waitForAcceptCalls).toBe(0);
    expect(endEventId).toBe('event-4');
  });
});
