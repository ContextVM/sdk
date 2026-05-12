import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { callToolStream } from './call-tool-stream.js';
import { OpenStreamSession } from './open-stream/index.js';

describe('callToolStream', () => {
  test('creates stream session and enables upstream progress handling', async () => {
    const stream = new OpenStreamSession({
      progressToken: '1',
      maxBufferedChunks: 4,
      maxBufferedBytes: 1024,
    });

    let capturedParams: CallToolRequest['params'] | undefined;
    let capturedOptions:
      | {
          onprogress?: (progress: unknown) => void;
          resetTimeoutOnProgress?: boolean;
        }
      | undefined;
    const client = new Client({
      name: 'call-tool-stream-test-client',
      version: '1.0.0',
    });

    client.callTool = async (params, _schema, options) => {
      capturedParams = params;
      capturedOptions = options as typeof capturedOptions;
      return {
        content: [],
        toolResult: { ok: true },
      };
    };

    const call = await callToolStream({
      client,
      transport: {
        prepareOutboundOpenStreamSession: async () => ({
          progressToken: '1',
          stream,
        }),
      } as unknown as never,
      name: 'subscribeToEvents',
      arguments: { topic: 'orders' },
    });

    expect(call.progressToken).toBe('1');
    expect(call.stream).toBe(stream);
    await expect(call.result).resolves.toEqual({
      content: [],
      toolResult: { ok: true },
    });
    expect(capturedParams).toEqual({
      name: 'subscribeToEvents',
      arguments: { topic: 'orders' },
    });
    expect(capturedOptions?.resetTimeoutOnProgress).toBe(true);
    expect(typeof capturedOptions?.onprogress).toBe('function');
  });

  test('rejects when the outbound stream session cannot be prepared', async () => {
    const client = new Client({
      name: 'call-tool-stream-test-client',
      version: '1.0.0',
    });

    client.callTool = async () => ({
      content: [],
      toolResult: { ok: true },
    });

    await expect(
      callToolStream({
        client,
        transport: {
          prepareOutboundOpenStreamSession: async () => {
            throw new Error('transport closed');
          },
        } as unknown as never,
        name: 'subscribeToEvents',
      }),
    ).rejects.toThrow('transport closed');
  });
});
