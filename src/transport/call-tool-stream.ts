import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { OpenStreamSession } from './open-stream/index.js';
import type { NostrClientTransport } from './nostr-client-transport.js';

export interface CallToolStreamParams {
  client: Client;
  transport: NostrClientTransport;
  name: CallToolRequest['params']['name'];
  arguments?: CallToolRequest['params']['arguments'];
  onprogress?: (progress: unknown) => void;
}

export interface ToolStreamCall<TResult = unknown> {
  readonly progressToken: string;
  readonly stream: OpenStreamSession;
  readonly result: Promise<TResult>;
  abort(reason?: string): Promise<void>;
}

/**
 * Calls an MCP tool with a CEP-41 progress token and returns the paired stream handle.
 */
export async function callToolStream<TResult = unknown>(
  params: CallToolStreamParams,
): Promise<ToolStreamCall<TResult>> {
  const {
    client,
    transport,
    name,
    arguments: toolArguments,
    onprogress,
  } = params;
  const pendingStream = transport.prepareOutboundOpenStreamSession();

  const result = client.callTool(
    {
      name,
      arguments: toolArguments,
    } satisfies CallToolRequest['params'],
    undefined,
    {
      onprogress: onprogress ?? (() => undefined),
      resetTimeoutOnProgress: true,
    },
  ) as Promise<TResult>;

  const { progressToken, stream } = await pendingStream;

  return {
    progressToken,
    stream,
    result,
    abort: (reason?: string): Promise<void> => stream.abort(reason),
  };
}
