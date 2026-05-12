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

export interface OpenStreamRegistryOptions {
  maxConcurrentStreams?: number;
  maxBufferedChunksPerStream?: number;
  maxBufferedBytesPerStream?: number;
  idleTimeoutMs?: number;
  probeTimeoutMs?: number;
  closeGracePeriodMs?: number;
  getSessionOptions?: (
    progressToken: string,
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

  public getSession(progressToken: string): OpenStreamSession | undefined {
    return this.sessions.get(progressToken);
  }

  public createSession(
    options:
      | string
      | (Pick<OpenStreamSessionOptions, 'progressToken'> &
          Partial<Omit<OpenStreamSessionOptions, 'progressToken'>>),
  ): OpenStreamSession {
    const sessionOptions =
      typeof options === 'string' ? { progressToken: options } : options;
    const { progressToken } = sessionOptions;
    const derivedSessionOptions = this.getSessionOptions?.(progressToken) ?? {};

    if (this.sessions.has(progressToken)) {
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
      onClose: async () => {
        try {
          await sessionOptions.onClose?.();
        } finally {
          this.sessions.delete(progressToken);
        }
      },
      onAbort: async (reason?: string) => {
        try {
          await sessionOptions.onAbort?.(reason);
        } finally {
          this.sessions.delete(progressToken);
        }
      },
    });

    this.sessions.set(progressToken, session);
    return session;
  }

  public getOrCreateSession(progressToken: string): OpenStreamSession {
    return this.getSession(progressToken) ?? this.createSession(progressToken);
  }

  public async processFrame(
    frame: OpenStreamProgress,
  ): Promise<OpenStreamSession> {
    const progressToken = String(frame.progressToken);
    const existingSession = this.getSession(progressToken);

    if (!existingSession) {
      if (frame.cvm.frameType !== 'start') {
        throw new OpenStreamSequenceError(
          `Received ${frame.cvm.frameType} frame before start for ${progressToken}`,
        );
      }
    }

    const session = existingSession ?? this.createSession(progressToken);
    await session.processFrame(frame.progress, frame.cvm);
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
