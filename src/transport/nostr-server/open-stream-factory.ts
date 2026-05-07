import { type JSONRPCResponse, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { OpenStreamWriter } from '../open-stream/index.js';

export interface ServerOpenStreamFactoryDeps {
  openStreamEnabled: boolean;
  sendNotification: (clientPubkey: string, notification: JSONRPCMessage) => Promise<void>;
  handleResponse: (response: JSONRPCResponse) => Promise<void>;
}

export class ServerOpenStreamFactory {
  private readonly writers = new Map<string, OpenStreamWriter>();
  private readonly pendingResponses = new Map<string, JSONRPCResponse>();

  constructor(private deps: ServerOpenStreamFactoryDeps) {}

  public getWriter(eventId: string): OpenStreamWriter | undefined {
    return this.writers.get(eventId);
  }

  public getWritersMap(): Map<string, OpenStreamWriter> {
    return this.writers;
  }

  public getPendingResponsesMap(): Map<string, JSONRPCResponse> {
    return this.pendingResponses;
  }

  public createWriterIfEnabled(
    eventId: string,
    clientPubkey: string,
    progressToken?: string,
  ): void {
    if (!this.deps.openStreamEnabled || !progressToken) {
      return;
    }

    const writer = new OpenStreamWriter({
      progressToken,
      publishFrame: async (frame) => {
        await this.deps.sendNotification(clientPubkey, {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: frame,
        });
        return undefined;
      },
      onClose: async (): Promise<void> => {
        await this.flushPendingResponse(eventId);
      },
      onAbort: async (): Promise<void> => {
        await this.flushPendingResponse(eventId);
      },
    });

    this.writers.set(eventId, writer);
  }

  public async flushPendingResponse(eventId: string): Promise<void> {
    const pendingResponse = this.pendingResponses.get(eventId);
    this.pendingResponses.delete(eventId);
    this.writers.delete(eventId);

    if (!pendingResponse) {
      return;
    }

    await this.deps.handleResponse(pendingResponse);
  }
}
