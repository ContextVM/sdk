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
}

/**
 * Minimal CEP-41 writer/session for server-side production.
 */
export class OpenStreamWriter {
  public readonly progressToken: string;

  private readonly publishFrame: OpenStreamFramePublisher;
  private readonly contentType: string | undefined;
  private progress = 0;
  private chunkIndex = 0;
  private started = false;
  private active = true;

  constructor(options: OpenStreamWriterOptions) {
    this.progressToken = options.progressToken;
    this.publishFrame = options.publishFrame;
    this.contentType = options.contentType;
  }

  public get isActive(): boolean {
    return this.active;
  }

  public async start(): Promise<void> {
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

  public async write(data: string): Promise<void> {
    await this.start();
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
  }

  public async ping(): Promise<void> {
    if (!this.active) {
      return;
    }

    const nonce = String(this.nextProgress());
    await this.publishFrame(
      buildOpenStreamPingFrame({
        progressToken: this.progressToken,
        progress: this.nextProgress(),
        nonce,
      }),
    );
  }

  public async pong(nonce: string): Promise<void> {
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
  }

  public async close(): Promise<void> {
    if (!this.active) {
      return;
    }

    await this.start();
    this.active = false;
    await this.publishFrame(
      buildOpenStreamCloseFrame({
        progressToken: this.progressToken,
        progress: this.nextProgress(),
        lastChunkIndex: this.chunkIndex > 0 ? this.chunkIndex - 1 : undefined,
      }),
    );
  }

  public async abort(reason?: string): Promise<void> {
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
  }

  private nextProgress(): number {
    this.progress += 1;
    return this.progress;
  }
}
