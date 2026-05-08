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
  private progress = 0;
  private chunkIndex = 0;
  private controlNonce = 0;
  private started = false;
  private active = true;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenStreamWriterOptions) {
    this.progressToken = options.progressToken;
    this.publishFrame = options.publishFrame;
    this.contentType = options.contentType;
    this.onClose = options.onClose;
    this.onAbort = options.onAbort;
  }

  public get isActive(): boolean {
    return this.active;
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

      this.active = false;
      await this.publishFrame(
        buildOpenStreamCloseFrame({
          progressToken: this.progressToken,
          progress: this.nextProgress(),
          lastChunkIndex: this.chunkIndex > 0 ? this.chunkIndex - 1 : undefined,
        }),
      );
      await this.onClose?.();
    });
  }

  public async abort(reason?: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.active) {
        return;
      }

      this.active = false;
      await this.publishFrame(
        buildOpenStreamAbortFrame({
          progressToken: this.progressToken,
          progress: this.nextProgress(),
          reason,
        }),
      );
      await this.onAbort?.(reason);
    });
  }

  private async startInternal(): Promise<void> {
    if (this.started || !this.active) {
      return;
    }

    this.started = true;
    await this.publishFrame(
      buildOpenStreamStartFrame({
        progressToken: this.progressToken,
        progress: this.nextProgress(),
        contentType: this.contentType,
      }),
    );
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
