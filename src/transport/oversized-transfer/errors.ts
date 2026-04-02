/** Base class for oversized transfer failures. */
export class OversizedTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferError';
  }
}

/** Raised when the remote peer explicitly aborts a transfer. */
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

/** Raised when declared transfer parameters violate local policy limits. */
export class OversizedTransferPolicyError extends OversizedTransferError {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferPolicyError';
  }
}

/** Raised when framing/order rules are invalid for a transfer. */
export class OversizedTransferProtocolError extends OversizedTransferError {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferProtocolError';
  }
}

/** Raised when reconstructed payload length or digest does not match start frame. */
export class OversizedTransferIntegrityError extends OversizedTransferError {
  constructor(message: string) {
    super(message);
    this.name = 'OversizedTransferIntegrityError';
  }
}
