import { DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS } from './constants.js';
import type { OpenStreamProgress } from './types.js';
import {
  buildOpenStreamAbortFrame,
  buildOpenStreamChunkFrame,
  buildOpenStreamCloseFrame,
  buildOpenStreamPingFrame,
  buildOpenStreamPongFrame,
  buildOpenStreamStartFrame,
} from './frames.js';

export type OpenStreamFramePublisher = (
  frame: OpenStreamProgress,
) => Promise<string | undefined>;

export interface OpenStreamWriterOptions {
  progressToken: string;
  publishFrame: OpenStreamFramePublisher;
  contentType?: string;
  onClose?: () => Promise<void>;
  onAbort?: (reason?: string) => Promise<void>;
  /**
   * Sender-side keepalive (CEP-41). When set, the writer arms an idle timer
   * once it starts streaming and probes the peer with `ping` frames; a peer
   * that never responds within {@link probeTimeoutMs} aborts the stream.
   * Omit to disable keepalive (e.g. in unit tests).
   */
  idleTimeoutMs?: number;
  probeTimeoutMs?: number;
}

/**
 * Minimal CEP-41 writer/session for server-side production.
 */
export class OpenStreamWriter {
  public readonly progressToken: string;

  private readonly publishFrame: OpenStreamFramePublisher;
  private readonly contentType: string | undefined;
  private readonly onClose?: () => Promise<void>;
  private readonly onAbort?: (reason?: string) => Promise<void>;
  private readonly idleTimeoutMs: number | undefined;
  private readonly probeTimeoutMs: number | undefined;
  private progress = 0;
  private chunkIndex = 0;
  private controlNonce = 0;
  private started = false;
  private active = true;
  private operationQueue: Promise<void> = Promise.resolve();
  private abortPromise?: Promise<void>;
  private readonly abortController = new AbortController();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingProbeNonce: string | undefined;

  constructor(options: OpenStreamWriterOptions) {
    this.progressToken = options.progressToken;
    this.publishFrame = options.publishFrame;
    this.contentType = options.contentType;
    this.onClose = options.onClose;
    this.onAbort = options.onAbort;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.probeTimeoutMs = options.probeTimeoutMs;
  }

  public get isActive(): boolean {
    return this.active;
  }

  /**
   * Reactive counterpart to {@link isActive}: an `AbortSignal` that aborts
   * when the writer terminates for any reason — explicit `close()`/`abort()`,
   * keepalive probe timeout, or transport teardown. Pass it to upstream
   * sources (`addEventListener(..., { signal })`, `fetch(url, { signal })`,
   * `AbortController`-based loops) so they tear down promptly even when no
   * new stream events would arrive to reveal a dead client.
   */
  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Whether the writer has begun streaming by emitting its first
   * `start`/`write` frame. Distinct from {@link isActive}, which is `true`
   * for any freshly-instantiated writer. Used to tell apart writers that a
   * tool actually uses for streaming from ones that were only created
   * because the request carried a progress token.
   */
  public get hasStarted(): boolean {
    return this.started;
  }

  public async start(): Promise<void> {
    await this.enqueue(async () => {
      await this.startInternal();
    });
  }

  public async write(data: string): Promise<void> {
    await this.enqueue(async () => {
      await this.startInternal();
      if (!this.active) {
        return;
      }

      await this.publishFrame(
        buildOpenStreamChunkFrame({
          progressToken: this.progressToken,
          progress: this.nextProgress(),
          chunkIndex: this.chunkIndex,
          data,
        }),
      );
      this.chunkIndex += 1;
    });
  }

  public async ping(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.active) {
        return;
      }

      const progress = this.nextProgress();
      await this.publishFrame(
        buildOpenStreamPingFrame({
          progressToken: this.progressToken,
          progress,
          nonce: this.nextControlNonce(),
        }),
      );
    });
  }

  public async pong(nonce: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.active) {
        return;
      }

      // An inbound ping means the peer is alive; refresh the keepalive idle
      // window before responding.
      this.armIdle();
      await this.publishFrame(
        buildOpenStreamPongFrame({
          progressToken: this.progressToken,
          progress: this.nextProgress(),
          nonce,
        }),
      );
    });
  }

  public async close(): Promise<void> {
    await this.enqueue(async () => {
      await this.startInternal();
      if (!this.active) {
        return;
      }

      this.markInactive();
      try {
        await this.publishFrame(
          buildOpenStreamCloseFrame({
            progressToken: this.progressToken,
            progress: this.nextProgress(),
            lastChunkIndex:
              this.chunkIndex > 0 ? this.chunkIndex - 1 : undefined,
          }),
        );
      } finally {
        await this.onClose?.();
      }
    });
  }

  public async abort(reason?: string): Promise<void> {
    if (this.abortPromise) {
      await this.abortPromise;
      return;
    }

    if (!this.active) {
      return;
    }

    this.markInactive();
    const progress = this.nextProgress();

    this.abortPromise = (async (): Promise<void> => {
      try {
        await this.publishFrame(
          buildOpenStreamAbortFrame({
            progressToken: this.progressToken,
            progress,
            reason,
          }),
        );
      } finally {
        await this.onAbort?.(reason);
      }
    })();

    await this.abortPromise;
  }

  /**
   * Acknowledges an inbound `pong` matching the pending keepalive probe.
   * Invoked by the server transport when the peer responds to our probe.
   */
  public ackProbe(nonce: string): void {
    if (!this.active || this.pendingProbeNonce !== nonce) {
      return;
    }

    this.pendingProbeNonce = undefined;
    this.clearProbeTimer();
    this.armIdle();
  }

  /**
   * Releases writer resources without publishing a terminal frame. Used on
   * transport teardown so armed keepalive timers do not outlive the writer.
   */
  public dispose(): void {
    this.markInactive();
  }

  // ponytail: idle/probe keepalive mirrors OpenStreamSession's state machine
  // (session.ts). Extract a shared StreamKeepalive helper if a third
  // sender-side consumer appears; for now the duplication is contained and
  // the writer owns the single outbound progress sequence a session cannot.
  private armIdle(): void {
    if (this.idleTimeoutMs === undefined || !this.active) {
      return;
    }

    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.handleIdleTimeout();
    }, this.idleTimeoutMs);
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

  private clearKeepalive(): void {
    this.clearIdleTimer();
    this.clearProbeTimer();
    this.pendingProbeNonce = undefined;
  }

  /**
   * Flips the writer inactive, tears down keepalive, and aborts the public
   * signal so reactive consumers stop producing. Idempotent: `abort()` is a
   * no-op once already aborted (Web Platform guarantee).
   */
  private markInactive(): void {
    this.active = false;
    this.clearKeepalive();
    this.abortController.abort();
  }

  private async handleIdleTimeout(): Promise<void> {
    if (!this.active || this.pendingProbeNonce !== undefined) {
      return;
    }

    const nonce = this.nextControlNonce();
    this.pendingProbeNonce = nonce;

    try {
      // Bypass the operation queue so a stuck app write cannot block
      // keepalive. nextProgress() is atomic with frame construction, so
      // monotonic progress holds even while queued writes interleave.
      await this.publishFrame(
        buildOpenStreamPingFrame({
          progressToken: this.progressToken,
          progress: this.nextProgress(),
          nonce,
        }),
      );
    } catch {
      if (!this.active) {
        return;
      }
      this.pendingProbeNonce = undefined;
      this.armIdle();
      return;
    }

    if (!this.active || this.pendingProbeNonce !== nonce) {
      return;
    }

    this.probeTimer = setTimeout(() => {
      void this.handleProbeTimeout(nonce);
    }, this.probeTimeoutMs ?? DEFAULT_OPEN_STREAM_PROBE_TIMEOUT_MS);
  }

  private async handleProbeTimeout(nonce: string): Promise<void> {
    if (!this.active || this.pendingProbeNonce !== nonce) {
      return;
    }

    await this.abort('Probe timeout');
  }

  private async startInternal(): Promise<void> {
    if (this.started || !this.active) {
      return;
    }

    await this.publishFrame(
      buildOpenStreamStartFrame({
        progressToken: this.progressToken,
        progress: this.nextProgress(),
        contentType: this.contentType,
      }),
    );
    this.started = true;
    this.armIdle();
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.operationQueue.then(operation);
    this.operationQueue = pending.catch(() => undefined);
    await pending;
  }

  private nextProgress(): number {
    this.progress += 1;
    return this.progress;
  }

  private nextControlNonce(): string {
    this.controlNonce += 1;
    return `${this.progressToken}:${this.controlNonce}`;
  }
}
