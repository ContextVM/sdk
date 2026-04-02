import {
    DEFAULT_MAX_ACCEPTABLE_BYTES,
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
import { OversizedTransferAbortError, OversizedTransferDigestError, OversizedTransferError, OversizedTransferPolicyError, OversizedTransferReassemblyError } from './errors.js';
import { bufferToHex } from './sender.js';


// Narrows an unknown value to `OversizedTransferFrame` via structural check. 
function isOversizedTransferFrame(value: unknown): value is OversizedTransferFrame {
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
    /** Hard timeout for an in-flight transfer in ms. */
    transferTimeoutMs?: number;
}

interface ActiveTransfer {
    progressToken: string;
    digest: string;
    totalBytes: number;
    totalChunks: number;
    receivedChunks: number;

    // Keyed by the outer `notifications/progress.params.progress` value. 
    chunks: Map<number, string>;
    startedAt: number;
    abortTimer: ReturnType<typeof setTimeout>;
}

interface AcceptWaiter {
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}


//Stateful reassembly engine for CEP-XX oversized transfers.
export class OversizedTransferReceiver {
    private readonly maxTransferBytes: number;
    private readonly maxTransferChunks: number;
    private readonly transferTimeoutMs: number;
    private readonly transfers = new Map<string, ActiveTransfer>();
    private readonly acceptWaiters = new Map<string, AcceptWaiter>();
    private readonly logger: Logger;

    //sets all the settings and policy constraints
    constructor(policy: TransferPolicy, logger: Logger) {
        this.maxTransferBytes = policy.maxTransferBytes ?? DEFAULT_MAX_ACCEPTABLE_BYTES;
        this.maxTransferChunks = policy.maxTransferChunks ?? DEFAULT_MAX_TRANSFER_CHUNKS;
        this.transferTimeoutMs = policy.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
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

        switch (cvm.frameType) {
            case 'start':
                return this.handleStart(token, progress, cvm);
            case 'accept':
                return this.handleAccept(token);
            case 'chunk':
                return this.handleChunk(token, progress, cvm);
            case 'end':
                return this.handleEnd(token);
            case 'abort':
                return this.handleAbort(token, cvm);
        }
    }

    //Returns a Promise that resolves when the remote peer sends an `accept` frame
    //or rejects on timeout.
    waitForAccept(token: string, timeoutMs: number = this.transferTimeoutMs): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.rejectAcceptWaiter(
                token,
                new OversizedTransferError(
                    `Superseded wait for accept (token: ${token})`,
                ),
            );

            const timer = setTimeout(() => {
                this.acceptWaiters.delete(token);
                reject(new OversizedTransferError(`Timeout waiting for accept (token: ${token})`));
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
    private handleStart(token: string, _progress: number, frame: StartFrame): null {
        if (this.transfers.has(token)) {
            this.logger.warn('Duplicate start frame; ignoring', { token });
            return null;
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
            chunks: new Map(),
            receivedChunks: 0,
            startedAt: Date.now(),
            abortTimer,
        });

        this.logger.debug('Oversized transfer started', {
            token,
            totalBytes: frame.totalBytes,
            totalChunks: frame.totalChunks,
        });

        return null;
    }

    private handleAccept(token: string): null {
        const resolvedWaiter = this.resolveAcceptWaiter(token);
        const transfer = this.transfers.get(token);
        if (!transfer) {
            if (!resolvedWaiter) {
                this.logger.warn('Accept frame with no active transfer', { token });
            }
            return null;
        }
        return null;
    }

    private handleChunk(token: string, progress: number, frame: ChunkFrame): null {
        const transfer = this.transfers.get(token);
        if (!transfer) {
            this.logger.warn('Chunk frame with no active transfer', { token, progress });
            return null;
        }

        // Relay may deliver the same event twice; deduplicate by progress key.
        if (transfer.chunks.has(progress)) return null;

        transfer.chunks.set(progress, frame.data);
        transfer.receivedChunks++;

        this.logger.debug('Chunk received', {
            token,
            progress,
            received: transfer.receivedChunks,
            total: transfer.totalChunks,
        });

        return null;
    }

    private async handleEnd(token: string): Promise<JSONRPCMessage | null> {
        const transfer = this.transfers.get(token);
        if (!transfer) {
            this.logger.warn('End frame with no active transfer', { token });
            return null;
        }

        // 1. Completeness check.
        if (transfer.receivedChunks !== transfer.totalChunks) {
            this.cleanup(token);
            throw new OversizedTransferReassemblyError(
                `Expected ${transfer.totalChunks} chunks but received ${transfer.receivedChunks} (token: ${token})`,
            );
        }

        // 2. Assemble in ascending progress order.
        const sortedKeys = Array.from(transfer.chunks.keys()).sort((a, b) => a - b);
        const assembled = sortedKeys.map((k) => transfer.chunks.get(k)!).join('');

        // 3. Byte-length validation.
        const encodedBytes = new TextEncoder().encode(assembled);
        if (encodedBytes.byteLength !== transfer.totalBytes) {
            this.cleanup(token);
            throw new OversizedTransferDigestError(
                `Byte length mismatch: expected ${transfer.totalBytes}, got ${encodedBytes.byteLength} (token: ${token})`,
            );
        }

        // 4. SHA-256 digest validation.
        const actualHash = await crypto.subtle.digest('SHA-256', encodedBytes);
        const actualDigest = DIGEST_PREFIX + bufferToHex(actualHash);
        if (actualDigest !== transfer.digest) {
            this.cleanup(token);
            throw new OversizedTransferDigestError(
                `SHA-256 digest mismatch (token: ${token})`,
            );
        }

        // 5. Parse and validate as a JSON-RPC message.
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
        this.rejectAcceptWaiter(
            token,
            new OversizedTransferAbortError(token, frame.reason),
        );
        this.cleanup(token);
        throw new OversizedTransferAbortError(token, frame.reason);
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