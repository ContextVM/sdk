import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { callToolStream } from './call-tool-stream.js';
import { OpenStreamSession } from './open-stream/index.js';

describe('callToolStream', () => {
  test('creates stream session and forwards progress token into tool call', async () => {
    const stream = new OpenStreamSession({
      progressToken: 'token-fixed',
      maxBufferedChunks: 4,
      maxBufferedBytes: 1024,
    });

    let capturedParams: CallToolRequest['params'] | undefined;
    const client = new Client({
      name: 'call-tool-stream-test-client',
      version: '1.0.0',
    });

    client.callTool = async (params) => {
      capturedParams = params;
      return {
        content: [],
        toolResult: { ok: true },
      };
    };

    const call = await callToolStream({
      client,
      transport: {
        getOrCreateOpenStreamSession: (progressToken: string) => {
          expect(progressToken).toBe('token-fixed');
          return stream;
        },
      } as unknown as never,
      name: 'subscribeToEvents',
      arguments: { topic: 'orders' },
      progressToken: 'token-fixed',
    });

    expect(call.progressToken).toBe('token-fixed');
    expect(call.stream).toBe(stream);
    await expect(call.result).resolves.toEqual({
      content: [],
      toolResult: { ok: true },
    });
    expect(capturedParams).toEqual({
      name: 'subscribeToEvents',
      arguments: { topic: 'orders' },
      _meta: { progressToken: 'token-fixed' },
    });
  });
});
