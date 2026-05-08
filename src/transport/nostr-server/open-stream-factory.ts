import { OpenStreamWriter, OpenStreamReceiver, buildOpenStreamPingFrame, buildOpenStreamPongFrame, buildOpenStreamAbortFrame } from '../open-stream/index.js';
import { type OpenStreamRegistryOptions } from '../open-stream/registry.js';
import { type Logger } from '../../core/utils/logger.js';
import { type CorrelationStore } from './correlation-store.js';
import { type JSONRPCMessage, type JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';

/**
 * Dependencies for the ServerOpenStreamFactory.
 */
export interface ServerOpenStreamFactoryDeps {
  openStreamEnabled: boolean;
  sendNotification: (clientPubkey: string, notification: JSONRPCMessage) => Promise<void>;
  handleResponse: (response: JSONRPCResponse) => Promise<void>;
  correlationStore: CorrelationStore;
  policy?: Partial<OpenStreamRegistryOptions>;
  logger: Logger;
}

/**
 * Manages the lifecycle of CEP-41 OpenStream instances for the server transport.
 */
export class ServerOpenStreamFactory {
  private readonly writers = new Map<string, OpenStreamWriter>();
  private readonly pendingResponses = new Map<string, JSONRPCResponse>();
  private readonly receiver: OpenStreamReceiver;

  constructor(private deps: ServerOpenStreamFactoryDeps) {
    this.receiver = new OpenStreamReceiver({
      maxConcurrentStreams: deps.policy?.maxConcurrentStreams,
      maxBufferedChunksPerStream: deps.policy?.maxBufferedChunksPerStream,
      maxBufferedBytesPerStream: deps.policy?.maxBufferedBytesPerStream,
      idleTimeoutMs: deps.policy?.idleTimeoutMs,
      probeTimeoutMs: deps.policy?.probeTimeoutMs,
      closeGracePeriodMs: deps.policy?.closeGracePeriodMs,
      getSessionOptions: (progressToken) => {
        let progress = 0;

        const getClientPubkey = () => {
          const eventId = this.deps.correlationStore.getEventIdByProgressToken(progressToken);
          if (!eventId) return undefined;
          const route = this.deps.correlationStore.getEventRoute(eventId);
          return route?.clientPubkey;
        };

        return {
          sendPing: async (nonce: string): Promise<void> => {
            progress += 1;
            const clientPubkey = getClientPubkey();
            if (!clientPubkey) return;
            await this.deps.sendNotification(clientPubkey, {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: buildOpenStreamPingFrame({
                progressToken,
                progress,
                nonce,
              }),
            });
          },
          sendPong: async (nonce: string): Promise<void> => {
            progress += 1;
            const clientPubkey = getClientPubkey();
            if (!clientPubkey) return;
            await this.deps.sendNotification(clientPubkey, {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: buildOpenStreamPongFrame({
                progressToken,
                progress,
                nonce,
              }),
            });
          },
          sendAbort: async (reason?: string): Promise<void> => {
            progress += 1;
            const clientPubkey = getClientPubkey();
            if (!clientPubkey) return;
            await this.deps.sendNotification(clientPubkey, {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: buildOpenStreamAbortFrame({
                progressToken,
                progress,
                reason,
              }),
            });
          },
        };
      },
      logger: deps.logger,
    });
  }

  /**
   * Gets the inbound OpenStreamReceiver instance used for CEP-41.
   */
  public getReceiver(): OpenStreamReceiver {
    return this.receiver;
  }

  /**
   * Gets an active OpenStreamWriter for a specific event ID.
   */
  public getWriter(eventId: string): OpenStreamWriter | undefined {
    return this.writers.get(eventId);
  }

  /**
   * Clears all active writers and pending responses.
   */
  public clear(): void {
    this.writers.clear();
    this.pendingResponses.clear();
  }

  /**
   * Checks if an event has an active stream and defers the response if so.
   * Returns true if deferred.
   */
  public deferIfStreamActive(eventId: string, response: JSONRPCResponse): boolean {
    const existingWriter = this.writers.get(eventId);
    if (existingWriter && existingWriter.isActive) {
      this.pendingResponses.set(eventId, response);
      return true;
    }
    return false;
  }

  /**
   * Conditionally creates a new OpenStreamWriter if the client supports it.
   */
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

  /**
   * Flushes a deferred response for a stream once it has closed or aborted.
   */
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
