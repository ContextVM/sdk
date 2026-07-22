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

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

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
  private queuedBytes = 0;
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
  private lastActivityTimestamp = Date.now();

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
    // Guarantee `closed` never surfaces as an unhandled rejection when a
    // consumer abandons it (e.g. iterates the stream but never touches
    // `closed`). This no-op handler marks the promise permanently handled;
    // external callers that attach their own handler still receive the same
    // rejection. Browser- and Node-safe: plain promise plumbing.
    void this.closed.catch(() => undefined);
  }

  public get isActive(): boolean {
    return this.active;
  }

  /**
   * Wall-clock timestamp (ms) of the last received frame (data, ping, or
   * pong). Updated on every inbound frame regardless of active/closed state.
   */
  public get lastActivityAt(): number {
    return this.lastActivityTimestamp;
  }

  /**
   * True when the keepalive should have confirmed liveness by now but hasn't.
   * Pure wall-clock over the session's own idle + probe window (+ margin), so
   * consumers in timer-throttled environments (browser background tabs) can
   * read it from a reliable trigger they own (e.g. Page Visibility). A cleanly
   * closed stream eventually reads stale — gate on {@link isActive} first.
   */
  public isStale(marginMs = 0): boolean {
    return (
      Date.now() - this.lastActivityTimestamp >
      this.idleTimeoutMs + this.probeTimeoutMs + marginMs
    );
  }

  public async abort(reason?: string): Promise<void> {
    if (!this.active) {
      return;
    }

    const error = new OpenStreamAbortError(this.progressToken, reason);
    await this.finishAborted(error, reason, true);
  }

  public async fail(error: Error): Promise<void> {
    if (!this.active) {
      return;
    }

    await this.finishAborted(error, error.message, false);
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
        this.assertValidLastChunkIndex(frame.lastChunkIndex);
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

          this.queuedBytes -= utf8ByteLength(value.value);

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
      return: async (): Promise<IteratorResult<PendingChunk>> => {
        // Invoked by `for await...of` on an early `break`/`return`/`throw`.
        // Abort so the peer is notified and armed timers are torn down;
        // best-effort so a clean break never throws even if the transport is
        // already dead (local finalization inside `abort()` is synchronous).
        // No-op when the session has already terminated.
        await this.abort().catch(() => undefined);
        return { done: true, value: undefined };
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

    const chunkBytes = utf8ByteLength(frame.data);
    if (
      this.bufferedChunks.size + this.queue.length >=
      this.maxBufferedChunks
    ) {
      throw new OpenStreamSequenceError(
        `Buffered chunk limit exceeded for stream ${this.progressToken}`,
      );
    }

    if (
      this.bufferedBytes + this.queuedBytes + chunkBytes >
      this.maxBufferedBytes
    ) {
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
      this.bufferedBytes -= utf8ByteLength(data);
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

    this.queuedBytes += utf8ByteLength(value.value);
    this.queue.push(value);
  }

  private maybeFinishGracefully(): void {
    if (!this.closedRemotely || this.bufferedChunks.size > 0) {
      return;
    }

    const expectedLastChunkIndex = this.closeState?.expectedLastChunkIndex;
    if (expectedLastChunkIndex !== undefined) {
      if (this.nextExpectedChunkIndex !== expectedLastChunkIndex + 1) {
        throw new OpenStreamSequenceError(
          `Incomplete stream for ${this.progressToken}: expected chunks through ${expectedLastChunkIndex}`,
        );
      }
    }

    void this.finishClosed().catch(() => undefined);
  }

  private assertValidLastChunkIndex(lastChunkIndex: number | undefined): void {
    if (lastChunkIndex === undefined) {
      return;
    }

    if (!Number.isInteger(lastChunkIndex) || lastChunkIndex < 0) {
      throw new OpenStreamSequenceError(
        `Invalid lastChunkIndex for stream ${this.progressToken}`,
      );
    }
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
    // Refresh activity even past close so staleness holds during close-grace.
    this.lastActivityTimestamp = Date.now();
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
    // Arm BEFORE publishing: a stuck sendPing must not suppress detection; the
    // probe window intentionally covers publish latency. A late pong/resolve is
    // reconciled by handlePong's nonce match and clearTimers in finalize.
    this.clearProbeTimer();
    this.probeTimer = setTimeout(() => {
      this.handleProbeTimeout(nonce).catch(() => undefined);
    }, this.probeTimeoutMs);

    try {
      await this.sendPing?.(nonce);
    } catch (error) {
      if (!this.active) return; // probe timeout may have already finalized
      await this.finishAborted(
        error instanceof Error ? error : new Error(String(error)),
        'Failed to send keepalive ping',
        false,
      );
    }
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
    this.queuedBytes = 0;

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
