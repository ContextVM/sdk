import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
  type JSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../../core/utils/logger.js';
import {
  DEFAULT_MAX_CONCURRENT_TRANSFERS,
  DEFAULT_MAX_TRANSFER_BYTES,
  DEFAULT_MAX_TRANSFER_CHUNKS,
  DEFAULT_TRANSFER_TIMEOUT_MS,
  DIGEST_PREFIX,
  OVERSIZED_TRANSFER_TYPE,
} from './constants.js';
import {
  OversizedTransferAbortError,
  OversizedTransferError,
  OversizedTransferIntegrityError,
  OversizedTransferPolicyError,
  OversizedTransferProtocolError,
} from './errors.js';
import { sha256Digest, utf8ByteLength } from './sender.js';
import type {
  OversizedTransferAbortFrame,
  OversizedTransferAcceptFrame,
  OversizedTransferChunkFrame,
  OversizedTransferEndFrame,
  OversizedTransferFrameParseResult,
  OversizedTransferProgressNotification,
  OversizedTransferStartFrame,
  OversizedTransferSyntheticResult,
} from './types.js';

export interface TransferPolicy {
  /** Maximum accepted bytes declared by `start.totalBytes`. */
  maxTransferBytes?: number;
  /** Maximum accepted chunks declared by `start.totalChunks`. */
  maxTransferChunks?: number;
  /** Hard timeout for an in-flight transfer. */
  transferTimeoutMs?: number;
  /** Maximum number of concurrent in-flight transfers. */
  maxConcurrentTransfers?: number;
}

type OversizedTransferLogger = Pick<Logger, 'debug' | 'warn' | 'error'>;

type ActiveTransfer = {
  token: string;
  startProgress: number;
  acceptProgress: number | undefined;
  endProgress: number | undefined;
  digest: string;
  totalBytes: number;
  totalChunks: number;
  chunksByProgress: Map<number, string>;
  bufferedChunkBytes: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

type AcceptWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePositiveInteger(
  value: unknown,
  label: string,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new OversizedTransferProtocolError(
      `Invalid ${label} value for oversized transfer frame`,
    );
  }
  return value;
}

function parseFrame(
  notification: JSONRPCNotification,
): OversizedTransferFrameParseResult | null {
  if (notification.method !== 'notifications/progress') {
    return null;
  }

  const params = notification.params;
  if (!isRecord(params)) {
    return null;
  }

  const cvm = params.cvm;
  if (!isRecord(cvm) || cvm.type !== OVERSIZED_TRANSFER_TYPE) {
    return null;
  }

  const tokenRaw = params.progressToken;
  if (!(typeof tokenRaw === 'string' || typeof tokenRaw === 'number')) {
    throw new OversizedTransferProtocolError(
      'Missing or invalid progressToken for oversized transfer frame',
    );
  }

  const progress = parsePositiveInteger(params.progress, 'progress');
  const token = String(tokenRaw);

  const frameType = cvm.frameType;
  if (typeof frameType !== 'string') {
    throw new OversizedTransferProtocolError(
      'Missing frameType for oversized transfer frame',
    );
  }

  switch (frameType) {
    case 'start': {
      if (cvm.completionMode !== 'render') {
        throw new OversizedTransferProtocolError(
          'Unsupported completionMode for oversized transfer start frame',
        );
      }

      if (typeof cvm.digest !== 'string') {
        throw new OversizedTransferProtocolError(
          'Missing digest in oversized transfer start frame',
        );
      }

      const totalBytes = parsePositiveInteger(cvm.totalBytes, 'totalBytes');
      const totalChunks = parsePositiveInteger(cvm.totalChunks, 'totalChunks');

      const frame: OversizedTransferStartFrame = {
        type: OVERSIZED_TRANSFER_TYPE,
        frameType: 'start',
        completionMode: 'render',
        digest: cvm.digest,
        totalBytes,
        totalChunks,
      };

      return {
        token,
        progress,
        frame,
      };
    }

    case 'accept': {
      const frame: OversizedTransferAcceptFrame = {
        type: OVERSIZED_TRANSFER_TYPE,
        frameType: 'accept',
      };

      return {
        token,
        progress,
        frame,
      };
    }

    case 'chunk': {
      if (typeof cvm.data !== 'string') {
        throw new OversizedTransferProtocolError(
          'Missing data in oversized transfer chunk frame',
        );
      }

      const frame: OversizedTransferChunkFrame = {
        type: OVERSIZED_TRANSFER_TYPE,
        frameType: 'chunk',
        data: cvm.data,
      };

      return {
        token,
        progress,
        frame,
      };
    }

    case 'end': {
      const frame: OversizedTransferEndFrame = {
        type: OVERSIZED_TRANSFER_TYPE,
        frameType: 'end',
      };

      return {
        token,
        progress,
        frame,
      };
    }

    case 'abort': {
      if (cvm.reason !== undefined && typeof cvm.reason !== 'string') {
        throw new OversizedTransferProtocolError(
          'Invalid reason in oversized transfer abort frame',
        );
      }

      const frame: OversizedTransferAbortFrame = {
        type: OVERSIZED_TRANSFER_TYPE,
        frameType: 'abort',
        reason: cvm.reason,
      };

      return {
        token,
        progress,
        frame,
      };
    }

    default:
      throw new OversizedTransferProtocolError(
        `Unsupported frameType for oversized transfer: ${String(frameType)}`,
      );
  }
}

const NOOP_LOGGER: OversizedTransferLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Stateful reassembly engine for framed oversized transfers.
 */
export class OversizedTransferReceiver {
  private readonly maxTransferBytes: number;
  private readonly maxTransferChunks: number;
  private readonly transferTimeoutMs: number;
  private readonly maxConcurrentTransfers: number;

  private readonly transfers = new Map<string, ActiveTransfer>();
  private readonly acceptWaiters = new Map<string, AcceptWaiter>();
  private readonly earlyAccepts = new Map<string, number>();
  private readonly logger: OversizedTransferLogger;

  constructor(policy: TransferPolicy = {}, logger?: OversizedTransferLogger) {
    this.maxTransferBytes =
      policy.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES;
    this.maxTransferChunks =
      policy.maxTransferChunks ?? DEFAULT_MAX_TRANSFER_CHUNKS;
    this.transferTimeoutMs =
      policy.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    this.maxConcurrentTransfers =
      policy.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS;
    this.logger = logger ?? NOOP_LOGGER;
  }

  public static isOversizedFrame(
    message: JSONRPCMessage,
  ): message is OversizedTransferProgressNotification {
    if (
      !('method' in message) ||
      message.method !== 'notifications/progress' ||
      !isRecord(message.params)
    ) {
      return false;
    }

    const cvm = message.params.cvm;
    return isRecord(cvm) && cvm.type === OVERSIZED_TRANSFER_TYPE;
  }

  /**
   * Wait for an `accept` frame associated with a transfer token.
   */
  public waitForAccept(
    token: string,
    timeoutMs: number = this.transferTimeoutMs,
  ): Promise<void> {
    const now = Date.now();
    this.pruneEarlyAccepts(now);

    const earlyAcceptExpiry = this.earlyAccepts.get(token);
    if (earlyAcceptExpiry !== undefined && earlyAcceptExpiry > now) {
      this.earlyAccepts.delete(token);
      return Promise.resolve();
    }

    this.rejectAcceptWaiter(
      token,
      new OversizedTransferError(
        `Superseded oversized transfer accept waiter (token: ${token})`,
      ),
    );

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acceptWaiters.delete(token);
        reject(
          new OversizedTransferError(
            `Timed out waiting for oversized transfer accept (token: ${token})`,
          ),
        );
      }, timeoutMs);

      this.acceptWaiters.set(token, {
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Process one `notifications/progress` frame.
   */
  public processFrame(
    notification: JSONRPCNotification,
  ): OversizedTransferSyntheticResult {
    const parsed = parseFrame(notification);
    if (!parsed) {
      return null;
    }

    switch (parsed.frame.frameType) {
      case 'start':
        this.handleStart(parsed.token, parsed.progress, parsed.frame);
        return null;
      case 'accept':
        this.handleAccept(parsed.token, parsed.progress);
        return null;
      case 'chunk':
        this.handleChunk(parsed.token, parsed.progress, parsed.frame);
        return null;
      case 'end':
        return this.handleEnd(parsed.token, parsed.progress);
      case 'abort':
        return this.handleAbort(parsed.token, parsed.frame);
      default:
        return null;
    }
  }

  public get activeTransferCount(): number {
    return this.transfers.size;
  }

  /**
   * Release all active state and reject pending accept waiters.
   */
  public clear(): void {
    for (const transfer of this.transfers.values()) {
      clearTimeout(transfer.timeoutHandle);
    }

    for (const waiter of this.acceptWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new OversizedTransferError('Oversized receiver cleared'));
    }

    this.transfers.clear();
    this.acceptWaiters.clear();
    this.earlyAccepts.clear();
  }

  private handleStart(
    token: string,
    progress: number,
    frame: OversizedTransferStartFrame,
  ): void {
    const existing = this.transfers.get(token);
    if (existing) {
      const isDuplicateStart =
        existing.startProgress === progress &&
        existing.digest === frame.digest &&
        existing.totalBytes === frame.totalBytes &&
        existing.totalChunks === frame.totalChunks;

      if (isDuplicateStart) {
        return;
      }

      throw new OversizedTransferProtocolError(
        `Received duplicate start for active oversized transfer token: ${token}`,
      );
    }

    if (this.transfers.size >= this.maxConcurrentTransfers) {
      throw new OversizedTransferPolicyError(
        `Too many concurrent oversized transfers (max: ${this.maxConcurrentTransfers})`,
      );
    }

    if (frame.totalBytes > this.maxTransferBytes) {
      throw new OversizedTransferPolicyError(
        `Oversized transfer exceeds byte policy (token: ${token}, declared: ${frame.totalBytes}, max: ${this.maxTransferBytes})`,
      );
    }

    if (frame.totalChunks > this.maxTransferChunks) {
      throw new OversizedTransferPolicyError(
        `Oversized transfer exceeds chunk policy (token: ${token}, declared: ${frame.totalChunks}, max: ${this.maxTransferChunks})`,
      );
    }

    if (!frame.digest.startsWith(DIGEST_PREFIX)) {
      throw new OversizedTransferProtocolError(
        `Invalid digest format in oversized transfer start frame (token: ${token})`,
      );
    }

    const transfer: ActiveTransfer = {
      token,
      startProgress: progress,
      acceptProgress: undefined,
      endProgress: undefined,
      digest: frame.digest,
      totalBytes: frame.totalBytes,
      totalChunks: frame.totalChunks,
      chunksByProgress: new Map<number, string>(),
      bufferedChunkBytes: 0,
      timeoutHandle: this.createTransferTimeout(token),
    };

    this.transfers.set(token, transfer);
  }

  private handleAccept(token: string, progress: number): void {
    const resolvedWaiter = this.resolveAcceptWaiter(token);
    if (resolvedWaiter) {
      this.earlyAccepts.delete(token);
    }

    const transfer = this.transfers.get(token);
    if (!transfer) {
      if (!resolvedWaiter) {
        const expiresAt = Date.now() + this.transferTimeoutMs;
        this.earlyAccepts.set(token, expiresAt);
        this.pruneEarlyAccepts(Date.now());
      }
      return;
    }

    if (progress <= transfer.startProgress) {
      throw new OversizedTransferProtocolError(
        `Non-monotonic accept progress in oversized transfer (token: ${token})`,
      );
    }

    if (transfer.endProgress !== undefined && progress >= transfer.endProgress) {
      throw new OversizedTransferProtocolError(
        `Accept progress must be lower than end progress (token: ${token})`,
      );
    }

    if (transfer.acceptProgress !== undefined) {
      if (transfer.acceptProgress !== progress) {
        throw new OversizedTransferProtocolError(
          `Conflicting duplicate accept frame for oversized transfer (token: ${token})`,
        );
      }
      return;
    }

    transfer.acceptProgress = progress;
    this.touchTransfer(token, transfer);
  }

  private handleChunk(
    token: string,
    progress: number,
    frame: OversizedTransferChunkFrame,
  ): void {
    const transfer = this.transfers.get(token);
    if (!transfer) {
      this.logger.warn('Ignoring chunk for unknown oversized transfer token', {
        token,
        progress,
      });
      return;
    }

    if (progress <= transfer.startProgress) {
      this.cleanupTransfer(token);
      throw new OversizedTransferProtocolError(
        `Chunk progress must be greater than start progress (token: ${token})`,
      );
    }

    if (
      transfer.acceptProgress !== undefined &&
      progress <= transfer.acceptProgress
    ) {
      this.cleanupTransfer(token);
      throw new OversizedTransferProtocolError(
        `Chunk progress must be greater than accept progress (token: ${token})`,
      );
    }

    if (transfer.endProgress !== undefined && progress >= transfer.endProgress) {
      this.cleanupTransfer(token);
      throw new OversizedTransferProtocolError(
        `Chunk progress must be lower than end progress (token: ${token})`,
      );
    }

    const previousChunk = transfer.chunksByProgress.get(progress);
    if (previousChunk !== undefined) {
      if (previousChunk !== frame.data) {
        this.cleanupTransfer(token);
        throw new OversizedTransferProtocolError(
          `Conflicting duplicate chunk frame in oversized transfer (token: ${token}, progress: ${progress})`,
        );
      }
      return;
    }

    transfer.chunksByProgress.set(progress, frame.data);
    transfer.bufferedChunkBytes += utf8ByteLength(frame.data);

    if (transfer.chunksByProgress.size > transfer.totalChunks) {
      this.cleanupTransfer(token);
      throw new OversizedTransferProtocolError(
        `Received more chunks than declared in start frame (token: ${token})`,
      );
    }

    if (transfer.bufferedChunkBytes > transfer.totalBytes) {
      this.cleanupTransfer(token);
      throw new OversizedTransferProtocolError(
        `Buffered chunk bytes exceed declared totalBytes (token: ${token})`,
      );
    }

    this.touchTransfer(token, transfer);
  }

  private handleEnd(token: string, progress: number): JSONRPCMessage | null {
    const transfer = this.transfers.get(token);
    if (!transfer) {
      this.logger.warn('Ignoring end for unknown oversized transfer token', {
        token,
        progress,
      });
      return null;
    }

    try {
      if (progress <= transfer.startProgress) {
        throw new OversizedTransferProtocolError(
          `End progress must be greater than start progress (token: ${token})`,
        );
      }

      if (
        transfer.acceptProgress !== undefined &&
        progress <= transfer.acceptProgress
      ) {
        throw new OversizedTransferProtocolError(
          `End progress must be greater than accept progress (token: ${token})`,
        );
      }

      if (transfer.endProgress !== undefined && transfer.endProgress !== progress) {
        throw new OversizedTransferProtocolError(
          `Conflicting duplicate end frame in oversized transfer (token: ${token})`,
        );
      }
      transfer.endProgress = progress;

      if (transfer.chunksByProgress.size !== transfer.totalChunks) {
        throw new OversizedTransferProtocolError(
          `Chunk completeness mismatch in oversized transfer (token: ${token}, expected: ${transfer.totalChunks}, received: ${transfer.chunksByProgress.size})`,
        );
      }

      const sortedChunks = [...transfer.chunksByProgress.entries()].sort(
        ([left], [right]) => left - right,
      );

      const smallestChunkProgress = sortedChunks[0]?.[0];
      const hasReservedAcceptSlot =
        transfer.acceptProgress === undefined &&
        smallestChunkProgress !== undefined &&
        smallestChunkProgress === transfer.startProgress + 2;

      for (const [chunkProgress] of sortedChunks) {
        if (chunkProgress >= progress) {
          throw new OversizedTransferProtocolError(
            `Chunk progress must be lower than end progress (token: ${token})`,
          );
        }

        if (
          transfer.acceptProgress !== undefined &&
          chunkProgress <= transfer.acceptProgress
        ) {
          throw new OversizedTransferProtocolError(
            `Chunk progress must be greater than accept progress (token: ${token})`,
          );
        }
      }

      const frameCountBetween = progress - transfer.startProgress - 1;
      const expectedBetweenCount =
        transfer.totalChunks +
        (transfer.acceptProgress !== undefined || hasReservedAcceptSlot ? 1 : 0);

      if (frameCountBetween !== expectedBetweenCount) {
        throw new OversizedTransferProtocolError(
          `Unresolved progress gaps in oversized transfer (token: ${token})`,
        );
      }

      const assembled = sortedChunks.map(([, chunk]) => chunk).join('');

      if (utf8ByteLength(assembled) !== transfer.totalBytes) {
        throw new OversizedTransferIntegrityError(
          `Byte-length mismatch in oversized transfer (token: ${token})`,
        );
      }

      if (sha256Digest(assembled) !== transfer.digest) {
        throw new OversizedTransferIntegrityError(
          `Digest mismatch in oversized transfer (token: ${token})`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(assembled);
      } catch (error) {
        throw new OversizedTransferProtocolError(
          `Reassembled oversized payload is not valid JSON (token: ${token}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const validated = JSONRPCMessageSchema.safeParse(parsed);
      if (!validated.success) {
        throw new OversizedTransferProtocolError(
          `Reassembled oversized payload is not a valid JSON-RPC message (token: ${token})`,
        );
      }

      return validated.data;
    } finally {
      this.cleanupTransfer(token);
    }
  }

  private handleAbort(
    token: string,
    frame: OversizedTransferAbortFrame,
  ): OversizedTransferSyntheticResult {
    const error = new OversizedTransferAbortError(token, frame.reason);
    const hadTransfer = this.transfers.has(token);
    const hadWaiter = this.rejectAcceptWaiter(token, error);
    this.cleanupTransfer(token);

    if (!hadTransfer && !hadWaiter) {
      this.logger.warn('Ignoring abort for unknown oversized transfer token', {
        token,
      });
      return null;
    }

    throw error;
  }

  private createTransferTimeout(
    token: string,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.cleanupTransfer(token);
      this.rejectAcceptWaiter(
        token,
        new OversizedTransferError(
          `Oversized transfer timed out (token: ${token})`,
        ),
      );
      this.logger.warn('Oversized transfer timed out', { token });
    }, this.transferTimeoutMs);
  }

  private touchTransfer(token: string, transfer: ActiveTransfer): void {
    clearTimeout(transfer.timeoutHandle);
    transfer.timeoutHandle = this.createTransferTimeout(token);
  }

  private cleanupTransfer(token: string): void {
    const transfer = this.transfers.get(token);
    if (!transfer) {
      return;
    }

    clearTimeout(transfer.timeoutHandle);
    this.transfers.delete(token);
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

  private pruneEarlyAccepts(now: number): void {
    for (const [token, expiresAt] of this.earlyAccepts.entries()) {
      if (expiresAt <= now) {
        this.earlyAccepts.delete(token);
      }
    }

    while (this.earlyAccepts.size > this.maxConcurrentTransfers) {
      const first = this.earlyAccepts.keys().next();
      if (first.done) {
        break;
      }
      this.earlyAccepts.delete(first.value);
    }
  }
}
