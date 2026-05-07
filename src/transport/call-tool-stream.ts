import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { OpenStreamSession } from './open-stream/index.js';
import type { NostrClientTransport } from './nostr-client-transport.js';

export interface CallToolStreamParams {
  client: Client;
  transport: NostrClientTransport;
  name: CallToolRequest['params']['name'];
  arguments?: CallToolRequest['params']['arguments'];
  progressToken?: string;
}

export interface ToolStreamCall<TResult = unknown> {
  readonly progressToken: string;
  readonly stream: OpenStreamSession;
  readonly result: Promise<TResult>;
  abort(reason?: string): Promise<void>;
}

function createProgressToken(): string {
  return `open-stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Calls an MCP tool with a CEP-41 progress token and returns the paired stream handle.
 */
export async function callToolStream<TResult = unknown>(
  params: CallToolStreamParams,
): Promise<ToolStreamCall<TResult>> {
  const { client, transport, name, arguments: toolArguments } = params;
  const progressToken = params.progressToken ?? createProgressToken();
  const stream = transport.createOutboundOpenStreamSession(progressToken);

  const result = client.callTool({
    name,
    arguments: toolArguments,
    _meta: {
      progressToken,
    },
  } satisfies CallToolRequest['params']) as Promise<TResult>;

  return {
    progressToken,
    stream,
    result,
    abort: (reason?: string): Promise<void> => stream.abort(reason),
  };
}
