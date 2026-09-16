import {
  OpenStreamReceiver,
  OpenStreamSession,
  buildOpenStreamStartFrame,
  buildOpenStreamPingFrame,
  buildOpenStreamPongFrame,
  buildOpenStreamAbortFrame,
} from '../open-stream/index.js';
import {
  DEFAULT_OPEN_STREAM_CLOSE_GRACE_PERIOD_MS,
  DEFAULT_OPEN_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM,
  DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM,
} from '../open-stream/constants.js';
import type { OpenStreamTransportPolicy } from '../open-stream-policy.js';
import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';

/** Dependencies for the ClientOpenStreamFactory. */
export interface ClientOpenStreamFactoryDeps {
  openStreamEnabled: boolean;
  policy?: OpenStreamTransportPolicy;
  send: (message: JSONRPCMessage) => Promise<void>;
  logger: Logger;
  onerror?: (error: Error) => void;
}

/**
 * Manages the lifecycle of CEP-41 OpenStream instances for the client transport.
 *
 * Owns the inbound OpenStreamReceiver and exposes helpers for creating
 * outbound sessions with the correct ping/pong/abort wiring.
 */
export class ClientOpenStreamFactory {
  private readonly receiver: OpenStreamReceiver;
  private readonly policy: OpenStreamTransportPolicy | undefined;
  private readonly send: (message: JSONRPCMessage) => Promise<void>;
  /**
   * Per-token outbound progress counter. CEP-41 progress sequences are
   * per-sender: the client's start, ping, pong and abort frames for one
   * stream must share a single monotonic sequence.
   */
  private readonly outboundProgress = new Map<string, number>();

  constructor(deps: ClientOpenStreamFactoryDeps) {
    this.policy = deps.policy;
    this.send = deps.send;

    this.receiver = new OpenStreamReceiver({
      maxConcurrentStreams: deps.policy?.maxConcurrentStreams,
      maxBufferedChunksPerStream: deps.policy?.maxBufferedChunksPerStream,
      maxBufferedBytesPerStream: deps.policy?.maxBufferedBytesPerStream,
      idleTimeoutMs: deps.policy?.idleTimeoutMs,
      probeTimeoutMs: deps.policy?.probeTimeoutMs,
      closeGracePeriodMs: deps.policy?.closeGracePeriodMs,
      getSessionOptions: (progressToken) => {
        let progress = 0;
        return {
          sendPing: async (nonce: string): Promise<void> => {
            progress += 1;
            await this.send({
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
            await this.send({
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
            await this.send({
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

  /** Gets the inbound OpenStreamReceiver instance used for CEP-41. */
  public getReceiver(): OpenStreamReceiver {
    return this.receiver;
  }

  /** Returns an existing session for a progress token, or undefined. */
  public getSession(progressToken: string): OpenStreamSession | undefined {
    return this.receiver.getSession(progressToken);
  }

  /** Returns the session for a progress token, creating it lazily if needed. */
  public getOrCreateSession(progressToken: string): OpenStreamSession {
    return this.receiver.getOrCreateSession(progressToken);
  }

  /**
   * Creates an outbound CEP-41 session whose local ping/pong/abort
   * publishes the corresponding notification to the server.
   */
  public createOutboundSession(
    progressToken: string,
    options?: { locallyInitiated?: boolean },
  ): OpenStreamSession {
    const existing = this.receiver.getSession(progressToken);
    if (existing) {
      return existing;
    }

    return this.receiver.createSession({
      progressToken,
      locallyInitiated: options?.locallyInitiated,
      maxBufferedChunks:
        this.policy?.maxBufferedChunksPerStream ??
        DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM,
      maxBufferedBytes:
        this.policy?.maxBufferedBytesPerStream ??
        DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM,
      idleTimeoutMs:
        this.policy?.idleTimeoutMs ?? DEFAULT_OPEN_STREAM_IDLE_TIMEOUT_MS,
      probeTimeoutMs:
        this.policy?.probeTimeoutMs ?? DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS,
      closeGracePeriodMs:
        this.policy?.closeGracePeriodMs ??
        DEFAULT_OPEN_STREAM_CLOSE_GRACE_PERIOD_MS,
      sendPing: async (nonce: string): Promise<void> => {
        await this.send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: buildOpenStreamPingFrame({
            progressToken,
            progress: this.nextOutboundProgress(progressToken),
            nonce,
          }),
        });
      },
      sendPong: async (nonce: string): Promise<void> => {
        await this.send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: buildOpenStreamPongFrame({
            progressToken,
            progress: this.nextOutboundProgress(progressToken),
            nonce,
          }),
        });
      },
      sendAbort: async (reason?: string): Promise<void> => {
        await this.send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: buildOpenStreamAbortFrame({
            progressToken,
            progress: this.nextOutboundProgress(progressToken),
            reason,
          }),
        });
      },
      onClose: async (): Promise<void> => {
        this.outboundProgress.delete(progressToken);
      },
      onAbort: async (): Promise<void> => {
        this.outboundProgress.delete(progressToken);
      },
    });
  }

  /** Next value on the token's shared per-sender outbound sequence. */
  private nextOutboundProgress(progressToken: string): number {
    const next = (this.outboundProgress.get(progressToken) ?? 0) + 1;
    this.outboundProgress.set(progressToken, next);
    return next;
  }

  /**
   * Starts a client-to-server CEP-41 stream: creates the session that
   * receives the server's `accept` and control frames, then publishes
   * `start` as the first frame on the client's own outbound sequence for
   * the token. The token must be the progress token of the already-sent
   * request.
   */
  public async startStream(progressToken: string): Promise<OpenStreamSession> {
    const session = this.createOutboundSession(progressToken, {
      locallyInitiated: true,
    });
    await this.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: buildOpenStreamStartFrame({
        progressToken,
        progress: this.nextOutboundProgress(progressToken),
      }),
    });
    return session;
  }
}
