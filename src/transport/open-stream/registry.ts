import type { Logger } from '../../core/utils/logger.js';
import {
  DEFAULT_MAX_BUFFERED_BYTES_PER_STREAM,
  DEFAULT_MAX_BUFFERED_CHUNKS_PER_STREAM,
  DEFAULT_MAX_CONCURRENT_OPEN_STREAMS,
} from './constants.js';
import { OpenStreamPolicyError, OpenStreamSequenceError } from './errors.js';
import { OpenStreamSession, type OpenStreamSessionOptions } from './session.js';
import type { OpenStreamFrame, OpenStreamProgress } from './types.js';

export interface OpenStreamRegistryOptions {
  maxConcurrentStreams?: number;
  maxBufferedChunksPerStream?: number;
  maxBufferedBytesPerStream?: number;
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
        sessionOptions.maxBufferedChunks ?? this.maxBufferedChunksPerStream,
      maxBufferedBytes:
        sessionOptions.maxBufferedBytes ?? this.maxBufferedBytesPerStream,
      onClose: async () => {
        await sessionOptions.onClose?.();
        this.sessions.delete(progressToken);
      },
      onAbort: async (reason?: string) => {
        await sessionOptions.onAbort?.(reason);
        this.sessions.delete(progressToken);
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
    this.sessions.clear();
  }

  public get size(): number {
    return this.sessions.size;
  }
}
