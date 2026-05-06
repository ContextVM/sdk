import { OpenStreamAbortError, OpenStreamSequenceError } from './errors.js';
import type {
  OpenStreamChunkFrame,
  OpenStreamFrame,
  OpenStreamReadResult,
  OpenStreamSessionLike,
} from './types.js';

type Deferred<T> = {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  promise: Promise<T>;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { resolve, reject, promise };
}

type PendingChunk = OpenStreamReadResult<string>;

export interface OpenStreamSessionOptions {
  progressToken: string;
  maxBufferedChunks: number;
  maxBufferedBytes: number;
  onAbort?: (reason?: string) => Promise<void>;
  onClose?: () => Promise<void>;
}

/**
 * Readable client-side/session-side view of a CEP-41 stream.
 */
export class OpenStreamSession implements OpenStreamSessionLike<string> {
  public readonly progressToken: string;
  public readonly closed: Promise<void>;

  private readonly onAbort?: (reason?: string) => Promise<void>;
  private readonly onClose?: () => Promise<void>;
  private readonly closeDeferred = createDeferred<undefined>();
  private readonly waiters: Array<Deferred<IteratorResult<PendingChunk>>> = [];
  private readonly queue: PendingChunk[] = [];
  private readonly bufferedChunks = new Map<number, string>();
  private readonly maxBufferedChunks: number;
  private readonly maxBufferedBytes: number;
  private bufferedBytes = 0;
  private active = true;
  private started = false;
  private closedRemotely = false;
  private nextExpectedChunkIndex = 0;
  private lastProgress = -1;
  private terminalError: Error | undefined;

  constructor(options: OpenStreamSessionOptions) {
    this.progressToken = options.progressToken;
    this.maxBufferedChunks = options.maxBufferedChunks;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.onAbort = options.onAbort;
    this.onClose = options.onClose;
    this.closed = this.closeDeferred.promise;
  }

  public get isActive(): boolean {
    return this.active;
  }

  public async abort(reason?: string): Promise<void> {
    if (!this.active) {
      return;
    }

    const error = new OpenStreamAbortError(this.progressToken, reason);
    this.finish(error);
    await this.onAbort?.(reason);
  }

  public async processFrame(
    progress: number,
    frame: OpenStreamFrame,
  ): Promise<void> {
    this.assertActive();
    this.assertProgress(progress);

    switch (frame.frameType) {
      case 'start':
        if (this.started) {
          throw new OpenStreamSequenceError(
            `Duplicate start frame for stream ${this.progressToken}`,
          );
        }
        this.started = true;
        return;
      case 'accept':
      case 'ping':
      case 'pong':
        return;
      case 'chunk':
        this.assertStarted();
        this.bufferChunk(frame);
        this.flushContiguousChunks();
        return;
      case 'close':
        this.assertStarted();
        this.closedRemotely = true;
        this.flushContiguousChunks();
        this.maybeFinishGracefully();
        return;
      case 'abort':
        this.finish(new OpenStreamAbortError(this.progressToken, frame.reason));
        return;
      default:
        return;
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<PendingChunk> {
    return {
      next: async (): Promise<IteratorResult<PendingChunk>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (!value) {
            return { done: true, value: undefined };
          }

          return { done: false, value };
        }

        if (!this.active) {
          if (this.terminalError) {
            throw this.terminalError;
          }

          return { done: true, value: undefined };
        }

        const waiter = createDeferred<IteratorResult<PendingChunk>>();
        this.waiters.push(waiter);
        return waiter.promise;
      },
    };
  }

  private assertActive(): void {
    if (!this.active) {
      throw new OpenStreamSequenceError(
        `Received frame for inactive stream ${this.progressToken}`,
      );
    }
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new OpenStreamSequenceError(
        `Received non-start frame before start for ${this.progressToken}`,
      );
    }
  }

  private assertProgress(progress: number): void {
    if (!Number.isFinite(progress) || progress <= this.lastProgress) {
      throw new OpenStreamSequenceError(
        `Non-increasing progress for stream ${this.progressToken}`,
      );
    }

    this.lastProgress = progress;
  }

  private bufferChunk(frame: OpenStreamChunkFrame): void {
    if (!Number.isInteger(frame.chunkIndex) || frame.chunkIndex < 0) {
      throw new OpenStreamSequenceError(
        `Invalid chunkIndex for stream ${this.progressToken}`,
      );
    }

    if (this.bufferedChunks.has(frame.chunkIndex)) {
      throw new OpenStreamSequenceError(
        `Duplicate chunkIndex ${frame.chunkIndex} for ${this.progressToken}`,
      );
    }

    const chunkBytes = Buffer.byteLength(frame.data, 'utf8');
    if (
      this.bufferedChunks.size + this.queue.length >=
      this.maxBufferedChunks
    ) {
      throw new OpenStreamSequenceError(
        `Buffered chunk limit exceeded for stream ${this.progressToken}`,
      );
    }

    if (this.bufferedBytes + chunkBytes > this.maxBufferedBytes) {
      throw new OpenStreamSequenceError(
        `Buffered byte limit exceeded for stream ${this.progressToken}`,
      );
    }

    this.bufferedChunks.set(frame.chunkIndex, frame.data);
    this.bufferedBytes += chunkBytes;
  }

  private flushContiguousChunks(): void {
    while (this.bufferedChunks.has(this.nextExpectedChunkIndex)) {
      const data = this.bufferedChunks.get(this.nextExpectedChunkIndex);
      if (typeof data !== 'string') {
        break;
      }

      this.bufferedChunks.delete(this.nextExpectedChunkIndex);
      this.bufferedBytes -= Buffer.byteLength(data, 'utf8');
      this.emit({ value: data, chunkIndex: this.nextExpectedChunkIndex });
      this.nextExpectedChunkIndex += 1;
    }
  }

  private emit(value: PendingChunk): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }

    this.queue.push(value);
  }

  private maybeFinishGracefully(): void {
    if (!this.closedRemotely || this.bufferedChunks.size > 0) {
      return;
    }

    this.finish();
  }

  private finish(error?: Error): void {
    if (!this.active) {
      return;
    }

    this.active = false;
    this.terminalError = error;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        continue;
      }

      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve({ done: true, value: undefined });
      }
    }

    if (error) {
      this.closeDeferred.reject(error);
    } else {
      this.closeDeferred.resolve(undefined);
    }

    void this.onClose?.();
  }
}
