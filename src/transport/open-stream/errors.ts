/** Base class for all CEP-41 open-stream errors. */
export class OpenStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenStreamError';
  }
}

/** Thrown when a stream is aborted locally or by the remote peer. */
export class OpenStreamAbortError extends OpenStreamError {
  public readonly progressToken: string;
  public readonly reason: string | undefined;

  constructor(progressToken: string, reason?: string) {
    super(`Open stream aborted${reason ? `: ${reason}` : ''}`);
    this.name = 'OpenStreamAbortError';
    this.progressToken = progressToken;
    this.reason = reason;
  }
}

/** Thrown when a stream violates local admission or buffering policy. */
export class OpenStreamPolicyError extends OpenStreamError {
  constructor(message: string) {
    super(message);
    this.name = 'OpenStreamPolicyError';
  }
}

/** Thrown when CEP-41 lifecycle or ordering rules are violated. */
export class OpenStreamSequenceError extends OpenStreamError {
  constructor(message: string) {
    super(message);
    this.name = 'OpenStreamSequenceError';
  }
}
