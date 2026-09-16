import {
  OpenStreamReceiver,
  OpenStreamSession,
  OpenStreamWriter,
  type OpenStreamProgress,
  buildOpenStreamStartFrame,
  buildOpenStreamPingFrame,
  buildOpenStreamPongFrame,
  buildOpenStreamAbortFrame,
} from '../open-stream/index.js';
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
  private readonly send: (message: JSONRPCMessage) => Promise<void>;
  /**
   * Per-token outbound progress counter. CEP-41 progress sequences are
   * per-sender: the client's start, ping, pong and abort frames for one
   * stream must share a single monotonic sequence.
   */
  private readonly outboundProgress = new Map<string, number>();

  constructor(deps: ClientOpenStreamFactoryDeps) {
    this.send = deps.send;

    this.receiver = new OpenStreamReceiver({
      maxConcurrentStreams: deps.policy?.maxConcurrentStreams,
      maxBufferedChunksPerStream: deps.policy?.maxBufferedChunksPerStream,
      maxBufferedBytesPerStream: deps.policy?.maxBufferedBytesPerStream,
      idleTimeoutMs: deps.policy?.idleTimeoutMs,
      probeTimeoutMs: deps.policy?.probeTimeoutMs,
      closeGracePeriodMs: deps.policy?.closeGracePeriodMs,
      getSessionOptions: (progressToken) => ({
        sendPing: (nonce: string): Promise<void> =>
          this.sendControlFrame(progressToken, (progress) =>
            buildOpenStreamPingFrame({ progressToken, progress, nonce }),
          ),
        sendPong: (nonce: string): Promise<void> =>
          this.sendControlFrame(progressToken, (progress) =>
            buildOpenStreamPongFrame({ progressToken, progress, nonce }),
          ),
        sendAbort: (reason?: string): Promise<void> =>
          this.sendControlFrame(progressToken, (progress) =>
            buildOpenStreamAbortFrame({ progressToken, progress, reason }),
          ),
        onClose: async (): Promise<void> => {
          this.outboundProgress.delete(progressToken);
        },
        onAbort: async (): Promise<void> => {
          this.outboundProgress.delete(progressToken);
        },
      }),
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

    // Control-frame callbacks, buffer limits and lifecycle pruning come from
    // the receiver's getSessionOptions, which shares the per-token counter.
    return this.receiver.createSession({
      progressToken,
      locallyInitiated: options?.locallyInitiated,
    });
  }

  /** Next value on the token's shared per-sender outbound sequence. */
  private nextOutboundProgress(progressToken: string): number {
    const next = (this.outboundProgress.get(progressToken) ?? 0) + 1;
    this.outboundProgress.set(progressToken, next);
    return next;
  }

  /** Publishes a session control frame on the token's per-sender sequence. */
  private async sendControlFrame(
    progressToken: string,
    build: (progress: number) => OpenStreamProgress,
  ): Promise<void> {
    await this.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: build(this.nextOutboundProgress(progressToken)),
    });
  }

  /**
   * Starts a client-to-server CEP-41 stream on a request's progress token:
   * publishes `start` as the first frame on the client's own outbound
   * sequence, waits for the server's `accept` (CEP-41 requires the sender to
   * wait for accept before chunk frames), and returns the paired session and
   * writer. The writer's chunk/close/abort frames share the session's
   * per-sender sequence; keepalive is owned by the session.
   */
  public async startStream(
    progressToken: string,
  ): Promise<ClientOpenStreamHandle> {
    const session = this.createOutboundSession(progressToken, {
      locallyInitiated: true,
    });
    const writer = new OpenStreamWriter({
      progressToken,
      preStarted: true,
      nextProgress: () => this.nextOutboundProgress(progressToken),
      publishFrame: async (frame): Promise<string | undefined> => {
        await this.send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: frame,
        });
        return undefined;
      },
      onClose: async (): Promise<void> => {
        await session.close();
      },
      // The writer already published its abort frame; terminate the session
      // locally without publishing a second one (lifecycle cleanup runs and
      // prunes the shared counter).
      onAbort: async (reason?: string): Promise<void> => {
        await session.terminate(reason);
      },
    });
    await this.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: buildOpenStreamStartFrame({
        progressToken,
        progress: this.nextOutboundProgress(progressToken),
      }),
    });
    await session.accepted;
    return { session, writer };
  }
}

/** Client-side handle for a client-started CEP-41 stream. */
export interface ClientOpenStreamHandle {
  /** Session receiving the server's control frames; owns keepalive. */
  readonly session: OpenStreamSession;
  /** Ordered payload writer sharing the session's per-sender sequence. */
  readonly writer: OpenStreamWriter;
}
