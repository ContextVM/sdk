import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  DEFAULT_MAX_ACCEPTABLE_BYTES,
  DEFAULT_MAX_CONCURRENT_TRANSFERS,
  DEFAULT_MAX_OUT_OF_ORDER_CHUNKS,
  DEFAULT_MAX_OUT_OF_ORDER_WINDOW,
  DEFAULT_MAX_TRANSFER_CHUNKS,
  DEFAULT_TRANSFER_TIMEOUT_MS,
  DIGEST_PREFIX,
} from './constants.js';
import {
  JSONRPCMessage,
  JSONRPCMessageSchema,
  JSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';
import type {
  AbortFrame,
  ChunkFrame,
  OversizedTransferFrame,
  StartFrame,
} from './types.js';
import {
  OversizedTransferAbortError,
  OversizedTransferDigestError,
  OversizedTransferError,
  OversizedTransferPolicyError,
  OversizedTransferReassemblyError,
  OversizedTransferSequenceError,
} from './errors.js';

// Narrows an unknown value to `OversizedTransferFrame` via structural check.
function isOversizedTransferFrame(
  value: unknown,
): value is OversizedTransferFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as OversizedTransferFrame).type === 'oversized-transfer' &&
    typeof (value as OversizedTransferFrame).frameType === 'string'
  );
}

export interface TransferPolicy {
  maxTransferBytes?: number;
  maxTransferChunks?: number;
  maxConcurrentTransfers?: number;
  maxOutOfOrderWindow?: number;
  maxOutOfOrderChunks?: number;
  /** Hard timeout for an in-flight transfer in ms. */
  transferTimeoutMs?: number;
}

interface ActiveTransfer {
  progressToken: string;
  digest: string;
  totalBytes: number;
  totalChunks: number;
  startProgress: number;
  acceptProgress: number | null;
  firstChunkProgress: number | null;
  nextExpectedChunkProgress: number | null;
  highestObservedProgress: number;

  // Keyed by the outer `notifications/progress.params.progress` value.
  chunks: Map<number, string>;
  abortTimer: ReturnType<typeof setTimeout>;
}

interface AcceptWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

//Stateful reassembly engine for CEP-22 oversized transfers.
export class OversizedTransferReceiver {
  private readonly maxTransferBytes: number;
  private readonly maxTransferChunks: number;
  private readonly maxConcurrentTransfers: number;
  private readonly maxOutOfOrderWindow: number;
  private readonly maxOutOfOrderChunks: number;
  private readonly transferTimeoutMs: number;
  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly acceptWaiters = new Map<string, AcceptWaiter>();
  private readonly logger: Logger;

  //sets all the settings and policy constraints
  constructor(policy: TransferPolicy, logger: Logger) {
    this.maxTransferBytes =
      policy.maxTransferBytes ?? DEFAULT_MAX_ACCEPTABLE_BYTES;
    this.maxTransferChunks =
      policy.maxTransferChunks ?? DEFAULT_MAX_TRANSFER_CHUNKS;
    this.maxConcurrentTransfers =
      policy.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS;
    this.maxOutOfOrderWindow =
      policy.maxOutOfOrderWindow ?? DEFAULT_MAX_OUT_OF_ORDER_WINDOW;
    this.maxOutOfOrderChunks =
      policy.maxOutOfOrderChunks ?? DEFAULT_MAX_OUT_OF_ORDER_CHUNKS;
    this.transferTimeoutMs =
      policy.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    this.logger = logger;
  }

  //Returns true if the notification contains an oversized-transfer frame
  //in its `params.cvm` field.
  static isOversizedFrame(notification: JSONRPCNotification): boolean {
    return isOversizedTransferFrame(notification.params?.cvm);
  }

  /**
   * Process one inbound `notifications/progress` frame.
   *
   * @returns The reassembled `JSONRPCMessage` when the transfer is complete,
   *          or `null` when more frames are needed.
   * @throws `OversizedTransferAbortError` on `abort` frame.
   * @throws `OversizedTransferPolicyError` when limits are exceeded.
   * @throws `OversizedTransferDigestError` on integrity failure.
   * @throws `OversizedTransferReassemblyError` on structural failure.
   */

  //Process one inbound `notifications/progress` frame.
  async processFrame(
    notification: JSONRPCNotification,
  ): Promise<JSONRPCMessage | null> {
    const cvm = notification.params?.cvm;
    if (!isOversizedTransferFrame(cvm)) return null;

    const token = String(notification.params?.progressToken ?? '');
    // The outer `progress` value is the canonical ordering key for chunks.
    const progress = Number(notification.params?.progress ?? 0);

    this.assertValidToken(token);
    this.assertValidProgress(progress, token);

    switch (cvm.frameType) {
      case 'start':
        return this.handleStart(token, progress, cvm);
      case 'accept':
        return this.handleAccept(token, progress);
      case 'chunk':
        return this.handleChunk(token, progress, cvm);
      case 'end':
        return this.handleEnd(token, progress);
      case 'abort':
        return this.handleAbort(token, cvm);
    }
  }

  //Returns a Promise that resolves when the remote peer sends an `accept` frame
  //or rejects on timeout.
  waitForAccept(
    token: string,
    timeoutMs: number = this.transferTimeoutMs,
  ): Promise<void> {
    const transfer = this.transfers.get(token);
    if (transfer?.acceptProgress !== null) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.rejectAcceptWaiter(
        token,
        new OversizedTransferError(
          `Superseded wait for accept (token: ${token})`,
        ),
      );

      const timer = setTimeout(() => {
        this.acceptWaiters.delete(token);
        reject(
          new OversizedTransferError(
            `Timeout waiting for accept (token: ${token})`,
          ),
        );
      }, timeoutMs);

      this.acceptWaiters.set(token, { resolve, reject, timer });
    });
  }

  //Returns the number of currently active in-flight transfers.
  get activeTransferCount(): number {
    return this.transfers.size;
  }

  /** Releases all in-flight transfers and their watchdog timers. */
  clear(): void {
    for (const t of this.transfers.values()) {
      clearTimeout(t.abortTimer);
    }

    for (const waiter of this.acceptWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new OversizedTransferError('Receiver cleared'));
    }

    this.transfers.clear();
    this.acceptWaiters.clear();
  }

  //Handles the start frame
  private handleStart(
    token: string,
    progress: number,
    frame: StartFrame,
  ): null {
    if (this.transfers.has(token)) {
      throw new OversizedTransferSequenceError(
        `Duplicate start frame for active transfer (token: ${token})`,
      );
    }

    if (frame.totalBytes > this.maxTransferBytes) {
      throw new OversizedTransferPolicyError(
        `totalBytes ${frame.totalBytes} exceeds policy limit ${this.maxTransferBytes} (token: ${token})`,
      );
    }

    if (frame.totalChunks > this.maxTransferChunks) {
      throw new OversizedTransferPolicyError(
        `totalChunks ${frame.totalChunks} exceeds policy limit ${this.maxTransferChunks} (token: ${token})`,
      );
    }

    if (this.transfers.size >= this.maxConcurrentTransfers) {
      throw new OversizedTransferPolicyError(
        `Active transfers exceed policy limit ${this.maxConcurrentTransfers} (token: ${token})`,
      );
    }

    if (!frame.digest.startsWith(DIGEST_PREFIX)) {
      throw new OversizedTransferReassemblyError(
        `Invalid digest format in start frame (token: ${token})`,
      );
    }

    const abortTimer = setTimeout(() => {
      this.logger.warn('Transfer timed out; cleaning up', { token });
      this.rejectAcceptWaiter(
        token,
        new OversizedTransferError(`Transfer timed out (token: ${token})`),
      );
      this.cleanup(token);
    }, this.transferTimeoutMs);

    this.transfers.set(token, {
      progressToken: token,
      digest: frame.digest,
      totalBytes: frame.totalBytes,
      totalChunks: frame.totalChunks,
      startProgress: progress,
      acceptProgress: null,
      firstChunkProgress: null,
      nextExpectedChunkProgress: null,
      highestObservedProgress: progress,
      chunks: new Map(),
      abortTimer,
    });

    this.logger.debug('Oversized transfer started', {
      token,
      totalBytes: frame.totalBytes,
      totalChunks: frame.totalChunks,
    });

    return null;
  }

  private handleAccept(token: string, progress: number): null {
    const transfer = this.transfers.get(token);
    if (!transfer) {
      // Late or duplicated accept frames are ignored after transfer cleanup.
      if (!this.resolveAcceptWaiter(token)) {
        this.logger.warn('Accept frame with no active transfer', { token });
      }
      return null;
    }

    if (progress <= transfer.startProgress) {
      this.failTransfer(
        token,
        new OversizedTransferSequenceError(
          `Accept frame progress must be greater than start progress (token: ${token})`,
        ),
      );
    }

    transfer.highestObservedProgress = Math.max(
      transfer.highestObservedProgress,
      progress,
    );
    transfer.acceptProgress = progress;
    this.resolveAcceptWaiter(token);
    return null;
  }

  private handleChunk(
    token: string,
    progress: number,
    frame: ChunkFrame,
  ): null {
    const transfer = this.transfers.get(token);
    if (!transfer) {
      // Late or duplicated chunk frames are ignored after transfer cleanup.
      this.logger.warn('Chunk frame with no active transfer', {
        token,
        progress,
      });
      return null;
    }

    const minimumChunkProgress = transfer.startProgress + 1;
    const maximumChunkProgress =
      transfer.startProgress + transfer.totalChunks + 1;
    if (progress < minimumChunkProgress) {
      this.failTransfer(
        token,
        new OversizedTransferSequenceError(
          `Chunk progress must be greater than start progress (token: ${token})`,
        ),
      );
    }

    const nextExpectedChunkProgress =
      this.getNextExpectedChunkProgress(transfer);
    const forwardGap = progress - nextExpectedChunkProgress;
    if (forwardGap > this.maxOutOfOrderWindow) {
      this.failTransfer(
        token,
        new OversizedTransferPolicyError(
          `Out-of-order gap ${forwardGap} exceeds policy limit ${this.maxOutOfOrderWindow} (token: ${token})`,
        ),
      );
    }

    if (progress > maximumChunkProgress) {
      this.failTransfer(
        token,
        new OversizedTransferSequenceError(
          `Chunk progress exceeds declared transfer bounds (token: ${token})`,
        ),
      );
    }

    if (
      progress > transfer.startProgress + 2 &&
      !transfer.chunks.has(transfer.startProgress + 1) &&
      !transfer.chunks.has(transfer.startProgress + 2)
    ) {
      this.failTransfer(
        token,
        new OversizedTransferSequenceError(
          `First chunk skips beyond the reserved accept slot (token: ${token})`,
        ),
      );
    }

    const existingChunk = transfer.chunks.get(progress);
    if (existingChunk !== undefined) {
      if (existingChunk !== frame.data) {
        this.failTransfer(
          token,
          new OversizedTransferSequenceError(
            `Conflicting duplicate chunk detected (token: ${token}, progress: ${progress})`,
          ),
        );
      }
      return null;
    }

    transfer.chunks.set(progress, frame.data);
    transfer.highestObservedProgress = Math.max(
      transfer.highestObservedProgress,
      progress,
    );

    this.refreshChunkProgressState(transfer);

    if (forwardGap > 0) {
      if (
        this.getBufferedOutOfOrderChunkCount(transfer) >
        this.maxOutOfOrderChunks
      ) {
        this.failTransfer(
          token,
          new OversizedTransferPolicyError(
            `Buffered out-of-order chunks exceed policy limit ${this.maxOutOfOrderChunks} (token: ${token})`,
          ),
        );
      }
    }

    this.logger.debug('Chunk received', {
      token,
      progress,
      received: transfer.chunks.size,
      total: transfer.totalChunks,
    });

    return null;
  }

  private async handleEnd(
    token: string,
    progress: number,
  ): Promise<JSONRPCMessage | null> {
    const transfer = this.transfers.get(token);
    if (!transfer) {
      // Late or duplicated end frames are ignored after transfer cleanup.
      this.logger.warn('End frame with no active transfer', { token });
      return null;
    }

    if (progress <= transfer.highestObservedProgress) {
      this.failTransfer(
        token,
        new OversizedTransferSequenceError(
          `End frame progress must be greater than all prior transfer frames (token: ${token})`,
        ),
      );
    }

    if (transfer.totalChunks > 0 && transfer.chunks.size === 0) {
      this.failTransfer(
        token,
        new OversizedTransferReassemblyError(
          `Transfer ended before any chunks were received (token: ${token})`,
        ),
      );
    }

    if (transfer.chunks.size !== transfer.totalChunks) {
      this.failTransfer(
        token,
        new OversizedTransferReassemblyError(
          `Expected ${transfer.totalChunks} chunks but received ${transfer.chunks.size} (token: ${token})`,
        ),
      );
    }

    const assembled = this.assembleTransferPayload(transfer, token);

    // 1. Byte-length validation.
    const encodedBytes = new TextEncoder().encode(assembled);
    if (encodedBytes.byteLength !== transfer.totalBytes) {
      this.cleanup(token);
      throw new OversizedTransferDigestError(
        `Byte length mismatch: expected ${transfer.totalBytes}, got ${encodedBytes.byteLength} (token: ${token})`,
      );
    }

    // 2. SHA-256 digest validation.
    const actualDigest = DIGEST_PREFIX + bytesToHex(sha256(encodedBytes));
    if (actualDigest !== transfer.digest) {
      this.cleanup(token);
      throw new OversizedTransferDigestError(
        `SHA-256 digest mismatch (token: ${token})`,
      );
    }

    // 3. Parse and validate as a JSON-RPC message.
    let validated: JSONRPCMessage;
    try {
      const parsed: unknown = JSON.parse(assembled);
      validated = JSONRPCMessageSchema.parse(parsed);
    } catch (err) {
      this.cleanup(token);
      throw new OversizedTransferReassemblyError(
        `Reassembled payload is not a valid JSON-RPC message (token: ${token}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.cleanup(token);
    this.logger.debug('Oversized transfer complete', { token });
    return validated;
  }

  private handleAbort(token: string, frame: AbortFrame): null {
    const error = new OversizedTransferAbortError(token, frame.reason);
    this.rejectAcceptWaiter(token, error);
    this.cleanup(token);
    throw error;
  }

  private assertValidToken(token: string): void {
    if (token.length === 0) {
      throw new OversizedTransferSequenceError(
        'Oversized transfer frame is missing progressToken',
      );
    }
  }

  private assertValidProgress(progress: number, token: string): void {
    if (!Number.isInteger(progress) || progress <= 0) {
      throw new OversizedTransferSequenceError(
        `Invalid progress value ${String(progress)} (token: ${token})`,
      );
    }
  }

  private refreshChunkProgressState(transfer: ActiveTransfer): void {
    if (transfer.chunks.size === 0) {
      transfer.firstChunkProgress = null;
      transfer.nextExpectedChunkProgress = null;
      return;
    }

    const firstChunkProgress =
      transfer.acceptProgress !== null
        ? transfer.startProgress + 2
        : transfer.startProgress + 1;

    let nextExpectedChunkProgress = firstChunkProgress;
    while (transfer.chunks.has(nextExpectedChunkProgress)) {
      nextExpectedChunkProgress++;
    }

    transfer.firstChunkProgress = firstChunkProgress;
    transfer.nextExpectedChunkProgress = nextExpectedChunkProgress;
  }

  private getBufferedOutOfOrderChunkCount(transfer: ActiveTransfer): number {
    if (
      transfer.firstChunkProgress === null ||
      transfer.nextExpectedChunkProgress === null
    ) {
      return 0;
    }

    const contiguousChunkCount =
      transfer.nextExpectedChunkProgress - transfer.firstChunkProgress;
    return transfer.chunks.size - contiguousChunkCount;
  }

  private getNextExpectedChunkProgress(transfer: ActiveTransfer): number {
    if (transfer.nextExpectedChunkProgress !== null) {
      return transfer.nextExpectedChunkProgress;
    }

    return transfer.acceptProgress !== null
      ? transfer.startProgress + 2
      : transfer.startProgress + 1;
  }

  private assembleTransferPayload(
    transfer: ActiveTransfer,
    token: string,
  ): string {
    const firstChunkProgress = this.getAssemblyFirstChunkProgress(
      transfer,
      token,
    );

    const chunks: string[] = [];
    for (
      let progress = firstChunkProgress;
      progress < firstChunkProgress + transfer.totalChunks;
      progress++
    ) {
      const chunk = transfer.chunks.get(progress);
      if (chunk === undefined) {
        throw new OversizedTransferReassemblyError(
          `Missing chunk during assembly (token: ${token}, progress: ${progress})`,
        );
      }
      chunks.push(chunk);
    }

    return chunks.join('');
  }

  private getAssemblyFirstChunkProgress(
    transfer: ActiveTransfer,
    token: string,
  ): number {
    const directStartProgress = transfer.startProgress + 1;
    const acceptGatedStartProgress = transfer.startProgress + 2;

    if (this.hasCompleteChunkRange(transfer, directStartProgress)) {
      return directStartProgress;
    }

    if (this.hasCompleteChunkRange(transfer, acceptGatedStartProgress)) {
      return acceptGatedStartProgress;
    }

    throw new OversizedTransferReassemblyError(
      `Transfer ended with unresolved chunk gaps (token: ${token})`,
    );
  }

  private hasCompleteChunkRange(
    transfer: ActiveTransfer,
    firstChunkProgress: number,
  ): boolean {
    for (
      let progress = firstChunkProgress;
      progress < firstChunkProgress + transfer.totalChunks;
      progress++
    ) {
      if (!transfer.chunks.has(progress)) {
        return false;
      }
    }

    return true;
  }

  private failTransfer(token: string, error: Error): never {
    this.rejectAcceptWaiter(token, error);
    this.cleanup(token);
    throw error;
  }

  private resolveAcceptWaiter(token: string): boolean {
    const waiter = this.acceptWaiters.get(token);
    if (!waiter) {
      return false;
    }

    clearTimeout(waiter.timer);
    this.acceptWaiters.delete(token);
    waiter.resolve();
    return true;
  }

  private rejectAcceptWaiter(token: string, error: Error): boolean {
    const waiter = this.acceptWaiters.get(token);
    if (!waiter) {
      return false;
    }

    clearTimeout(waiter.timer);
    this.acceptWaiters.delete(token);
    waiter.reject(error);
    return true;
  }

  private cleanup(token: string): void {
    const t = this.transfers.get(token);
    if (t) clearTimeout(t.abortTimer);
    this.transfers.delete(token);
  }
}
