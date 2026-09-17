import type { Logger } from '../../core/utils/logger.js';
import {
  DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM,
  DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM,
  DEFAULT_MAX_CONCURRENT_OPEN_STREAMS,
  DEFAULT_OPEN_STREAM_CLOSE_GRACE_PERIOD_MS,
  DEFAULT_OPEN_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS,
} from './constants.js';
import { OpenStreamPolicyError, OpenStreamSequenceError } from './errors.js';
import { OpenStreamSession, type OpenStreamSessionOptions } from './session.js';
import type { OpenStreamFrame, OpenStreamProgress } from './types.js';

/**
 * Session creation input: a bare token or token plus overrides. Anything
 * omitted falls back to registry defaults (receiver construction values).
 */
export type OpenStreamCreateSessionOptions =
  | string
  | (Pick<OpenStreamSessionOptions, 'progressToken'> &
      Partial<Omit<OpenStreamSessionOptions, 'progressToken'>>);

export interface OpenStreamRegistryOptions {
  maxConcurrentStreams?: number;
  maxBufferedChunksPerStream?: number;
  maxBufferedBytesPerStream?: number;
  idleTimeoutMs?: number;
  probeTimeoutMs?: number;
  closeGracePeriodMs?: number;
  getSessionOptions?: (
    progressToken: string,
    senderPubkey?: string,
  ) => Partial<Omit<OpenStreamSessionOptions, 'progressToken'>>;
  logger: Logger;
}

function isOpenStreamFrame(value: unknown): value is OpenStreamFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as OpenStreamFrame).type === 'open-stream' &&
    typeof (value as OpenStreamFrame).frameType === 'string'
  );
}

/**
 * Registry of active CEP-41 sessions keyed by progress token.
 */
export class OpenStreamRegistry {
  /**
   * Server-side sessions are identified by (sender, token) so concurrent
   * same-token streams from different clients stay independent; the NUL
   * separator cannot appear in a pubkey.
   */
  private static sessionKey(
    progressToken: string,
    senderPubkey?: string,
  ): string {
    return senderPubkey
      ? `${senderPubkey}\u0000${progressToken}`
      : progressToken;
  }
  private readonly logger: Logger;
  private readonly maxConcurrentStreams: number;
  private readonly maxBufferedChunksPerStream: number;
  private readonly maxBufferedBytesPerStream: number;
  private readonly idleTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly closeGracePeriodMs: number;
  private readonly getSessionOptions:
    | ((
        progressToken: string,
        senderPubkey?: string,
      ) => Partial<Omit<OpenStreamSessionOptions, 'progressToken'>>)
    | undefined;
  private readonly sessions = new Map<string, OpenStreamSession>();

  constructor(options: OpenStreamRegistryOptions) {
    this.logger = options.logger;
    this.maxConcurrentStreams =
      options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_OPEN_STREAMS;
    this.maxBufferedChunksPerStream =
      options.maxBufferedChunksPerStream ??
      DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM;
    this.maxBufferedBytesPerStream =
      options.maxBufferedBytesPerStream ??
      DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM;
    this.idleTimeoutMs =
      options.idleTimeoutMs ?? DEFAULT_OPEN_STREAM_IDLE_TIMEOUT_MS;
    this.probeTimeoutMs =
      options.probeTimeoutMs ?? DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS;
    this.closeGracePeriodMs =
      options.closeGracePeriodMs ?? DEFAULT_OPEN_STREAM_CLOSE_GRACE_PERIOD_MS;
    this.getSessionOptions = options.getSessionOptions;
  }

  public static isOpenStreamProgress(
    value: unknown,
  ): value is OpenStreamProgress {
    return (
      typeof value === 'object' &&
      value !== null &&
      isOpenStreamFrame((value as OpenStreamProgress).cvm)
    );
  }

  public getSession(
    progressToken: string,
    senderPubkey?: string,
  ): OpenStreamSession | undefined {
    return this.sessions.get(
      OpenStreamRegistry.sessionKey(progressToken, senderPubkey),
    );
  }

  public createSession(
    options: OpenStreamCreateSessionOptions,
    senderPubkey?: string,
  ): OpenStreamSession {
    const sessionOptions =
      typeof options === 'string' ? { progressToken: options } : options;
    const { progressToken } = sessionOptions;
    const key = OpenStreamRegistry.sessionKey(progressToken, senderPubkey);
    const derivedSessionOptions =
      this.getSessionOptions?.(progressToken, senderPubkey) ?? {};

    if (this.sessions.has(key)) {
      throw new OpenStreamSequenceError(
        `Stream session already exists for ${progressToken}`,
      );
    }

    if (this.sessions.size >= this.maxConcurrentStreams) {
      throw new OpenStreamPolicyError(
        'Maximum concurrent open streams exceeded',
      );
    }

    const session = new OpenStreamSession({
      progressToken,
      senderPubkey,
      maxBufferedChunks:
        sessionOptions.maxBufferedChunks ??
        derivedSessionOptions.maxBufferedChunks ??
        this.maxBufferedChunksPerStream,
      maxBufferedBytes:
        sessionOptions.maxBufferedBytes ??
        derivedSessionOptions.maxBufferedBytes ??
        this.maxBufferedBytesPerStream,
      idleTimeoutMs:
        sessionOptions.idleTimeoutMs ??
        derivedSessionOptions.idleTimeoutMs ??
        this.idleTimeoutMs,
      probeTimeoutMs:
        sessionOptions.probeTimeoutMs ??
        derivedSessionOptions.probeTimeoutMs ??
        this.probeTimeoutMs,
      closeGracePeriodMs:
        sessionOptions.closeGracePeriodMs ??
        derivedSessionOptions.closeGracePeriodMs ??
        this.closeGracePeriodMs,
      sendPing: sessionOptions.sendPing ?? derivedSessionOptions.sendPing,
      sendPong: sessionOptions.sendPong ?? derivedSessionOptions.sendPong,
      sendAbort: sessionOptions.sendAbort ?? derivedSessionOptions.sendAbort,
      locallyInitiated:
        sessionOptions.locallyInitiated ??
        derivedSessionOptions.locallyInitiated ??
        false,
      onClose: async () => {
        try {
          // Each hook gets a chance to run even when the other fails.
          try {
            await sessionOptions.onClose?.();
          } finally {
            await derivedSessionOptions.onClose?.();
          }
        } finally {
          this.sessions.delete(key);
        }
      },
      onAbort: async (reason?: string) => {
        try {
          try {
            await sessionOptions.onAbort?.(reason);
          } finally {
            await derivedSessionOptions.onAbort?.(reason);
          }
        } finally {
          this.sessions.delete(key);
        }
      },
    });

    this.sessions.set(key, session);
    return session;
  }

  public getOrCreateSession(progressToken: string): OpenStreamSession {
    return this.getSession(progressToken) ?? this.createSession(progressToken);
  }

  public async processFrame(
    frame: OpenStreamProgress,
    senderPubkey?: string,
  ): Promise<OpenStreamSession> {
    const progressToken = String(frame.progressToken);
    // Server-side identity is (sender, token): two clients may legitimately
    // use the same client-local token concurrently, so a sender's frames
    // only ever route to that sender's own session.
    const existingSession = this.getSession(progressToken, senderPubkey);

    if (!existingSession) {
      if (frame.cvm.frameType !== 'start') {
        throw new OpenStreamSequenceError(
          `Received ${frame.cvm.frameType} frame before start for ${progressToken}`,
        );
      }
    }

    const session =
      existingSession ?? this.createSession(progressToken, senderPubkey);

    try {
      await session.processFrame(frame.progress, frame.cvm);
    } catch (error) {
      await session.fail(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }

    return session;
  }

  public deleteSession(progressToken: string): boolean {
    return this.sessions.delete(progressToken);
  }

  public clear(): void {
    this.logger.debug('Clearing open stream registry', {
      count: this.sessions.size,
    });

    for (const session of this.sessions.values()) {
      session.dispose();
    }

    this.sessions.clear();
  }

  public get size(): number {
    return this.sessions.size;
  }
}
