import {
  DEFAULT_OPEN_STREAM_CLOSE_GRACE_PERIOD_MS,
  DEFAULT_OPEN_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS,
} from './constants.js';
import { OpenStreamAbortError, OpenStreamSequenceError } from './errors.js';
import type {
  OpenStreamChunkFrame,
  OpenStreamFrame,
  OpenStreamPingFrame,
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
  idleTimeoutMs?: number;
  probeTimeoutMs?: number;
  closeGracePeriodMs?: number;
  sendPing?: (nonce: string) => Promise<void>;
  sendPong?: (nonce: string) => Promise<void>;
  sendAbort?: (reason?: string) => Promise<void>;
  onAbort?: (reason?: string) => Promise<void>;
  onClose?: () => Promise<void>;
}

type CloseState = {
  expectedLastChunkIndex?: number;
};

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
  private readonly idleTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly closeGracePeriodMs: number;
  private readonly sendPing?: (nonce: string) => Promise<void>;
  private readonly sendPong?: (nonce: string) => Promise<void>;
  private readonly sendAbort?: (reason?: string) => Promise<void>;
  private bufferedBytes = 0;
  private active = true;
  private started = false;
  private closedRemotely = false;
  private closeState: CloseState | undefined;
  private nextExpectedChunkIndex = 0;
  private lastProgress = -1;
  private terminalError: Error | undefined;
  private controlNonce = 0;
  private pendingProbeNonce: string | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private closeGraceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: OpenStreamSessionOptions) {
    this.progressToken = options.progressToken;
    this.maxBufferedChunks = options.maxBufferedChunks;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.idleTimeoutMs =
      options.idleTimeoutMs ?? DEFAULT_OPEN_STREAM_IDLE_TIMEOUT_MS;
    this.probeTimeoutMs =
      options.probeTimeoutMs ?? DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS;
    this.closeGracePeriodMs =
      options.closeGracePeriodMs ?? DEFAULT_OPEN_STREAM_CLOSE_GRACE_PERIOD_MS;
    this.sendPing = options.sendPing;
    this.sendPong = options.sendPong;
    this.sendAbort = options.sendAbort;
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
    await this.finishAborted(error, reason, true);
  }

  public dispose(): void {
    this.finalize();
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
        this.refreshIdleTimer();
        return;
      case 'accept':
        this.refreshIdleTimer();
        return;
      case 'ping':
        this.assertStarted();
        this.refreshIdleTimer();
        await this.handlePing(frame);
        return;
      case 'pong':
        this.assertStarted();
        this.refreshIdleTimer();
        this.handlePong(frame.nonce);
        return;
      case 'chunk':
        this.assertStarted();
        this.bufferChunk(frame);
        this.flushContiguousChunks();
        this.refreshIdleTimer();
        return;
      case 'close':
        this.assertStarted();
        this.closedRemotely = true;
        this.closeState = {
          expectedLastChunkIndex: frame.lastChunkIndex,
        };
        this.flushContiguousChunks();
        this.refreshIdleTimer();
        this.maybeFinishGracefully();
        this.armCloseGraceTimer();
        return;
      case 'abort':
        this.refreshIdleTimer();
        await this.finishAborted(
          new OpenStreamAbortError(this.progressToken, frame.reason),
          frame.reason,
          false,
        );
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

    if (frame.chunkIndex < this.nextExpectedChunkIndex) {
      throw new OpenStreamSequenceError(
        `Stale chunkIndex ${frame.chunkIndex} for ${this.progressToken}`,
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

    if (this.closedRemotely) {
      this.maybeFinishGracefully();
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

    const expectedLastChunkIndex = this.closeState?.expectedLastChunkIndex;
    if (expectedLastChunkIndex !== undefined) {
      if (
        !Number.isInteger(expectedLastChunkIndex) ||
        expectedLastChunkIndex < 0
      ) {
        throw new OpenStreamSequenceError(
          `Invalid lastChunkIndex for stream ${this.progressToken}`,
        );
      }

      if (this.nextExpectedChunkIndex !== expectedLastChunkIndex + 1) {
        throw new OpenStreamSequenceError(
          `Incomplete stream for ${this.progressToken}: expected chunks through ${expectedLastChunkIndex}`,
        );
      }
    }

    void this.finishClosed();
  }

  private async handlePing(frame: OpenStreamPingFrame): Promise<void> {
    await this.sendPong?.(frame.nonce);
  }

  private handlePong(nonce: string): void {
    if (this.pendingProbeNonce !== nonce) {
      return;
    }

    this.pendingProbeNonce = undefined;
    this.clearProbeTimer();
  }

  private refreshIdleTimer(): void {
    if (!this.active || this.closedRemotely) {
      return;
    }

    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.handleIdleTimeout().catch(() => undefined);
    }, this.idleTimeoutMs);
  }

  private async handleIdleTimeout(): Promise<void> {
    if (!this.active || this.closedRemotely || this.pendingProbeNonce) {
      return;
    }

    const nonce = this.nextControlNonce();
    this.pendingProbeNonce = nonce;

    try {
      await this.sendPing?.(nonce);
    } catch (error) {
      await this.finishAborted(
        error instanceof Error ? error : new Error(String(error)),
        'Failed to send keepalive ping',
        false,
      );
      return;
    }

    this.clearProbeTimer();
    this.probeTimer = setTimeout(() => {
      this.handleProbeTimeout(nonce).catch(() => undefined);
    }, this.probeTimeoutMs);
  }

  private async handleProbeTimeout(nonce: string): Promise<void> {
    if (!this.active || this.pendingProbeNonce !== nonce) {
      return;
    }

    await this.finishAborted(
      new OpenStreamAbortError(this.progressToken, 'Probe timeout'),
      'Probe timeout',
      true,
    );
  }

  private armCloseGraceTimer(): void {
    if (
      !this.active ||
      !this.closedRemotely ||
      this.bufferedChunks.size === 0
    ) {
      return;
    }

    this.clearCloseGraceTimer();
    this.closeGraceTimer = setTimeout(() => {
      this.handleCloseGraceTimeout().catch(() => undefined);
    }, this.closeGracePeriodMs);
  }

  private async handleCloseGraceTimeout(): Promise<void> {
    if (
      !this.active ||
      !this.closedRemotely ||
      this.bufferedChunks.size === 0
    ) {
      return;
    }

    await this.finishAborted(
      new OpenStreamAbortError(
        this.progressToken,
        'Close grace period expired',
      ),
      'Close grace period expired',
      true,
    );
  }

  private nextControlNonce(): string {
    this.controlNonce += 1;
    return `${this.progressToken}:${this.controlNonce}`;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private clearProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = undefined;
    }
  }

  private clearCloseGraceTimer(): void {
    if (this.closeGraceTimer) {
      clearTimeout(this.closeGraceTimer);
      this.closeGraceTimer = undefined;
    }
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    this.clearProbeTimer();
    this.clearCloseGraceTimer();
    this.pendingProbeNonce = undefined;
  }

  private finalize(error?: Error): void {
    if (!this.active) {
      return;
    }

    this.clearTimers();
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
  }

  private async finishClosed(): Promise<void> {
    this.finalize();
    await this.onClose?.();
  }

  private async finishAborted(
    error: Error,
    reason?: string,
    publishAbort: boolean = false,
  ): Promise<void> {
    this.finalize(error);
    if (publishAbort) {
      await this.sendAbort?.(reason);
    }
    await this.onAbort?.(reason);
  }
}
