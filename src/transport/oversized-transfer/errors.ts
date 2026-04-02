/** Base class for all CEP-XX transfer errors. */
export class OversizedTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferError';
  }
}

/** Thrown when the transfer is aborted by the remote peer. */
export class OversizedTransferAbortError extends OversizedTransferError {
  public readonly token: string;
  public readonly reason: string | undefined;
  constructor(token: string, reason?: string) {
    super(`Transfer aborted${reason ? `: ${reason}` : ''}`);
    this.name = 'OversizedTransferAbortError';
    this.token = token;
    this.reason = reason;
  }
}

/** Thrown when a frame violates the declared policy limits (totalBytes, totalChunks). */
export class OversizedTransferPolicyError extends OversizedTransferError {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferPolicyError';
  }
}

/** Thrown when the digest or byte-length of the reassembled payload does not match. */
export class OversizedTransferDigestError extends OversizedTransferError {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferDigestError';
  }
}

/** Thrown when chunks cannot be reassembled (missing frames, gap in sequence). */
export class OversizedTransferReassemblyError extends OversizedTransferError {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferReassemblyError';
  }
}
