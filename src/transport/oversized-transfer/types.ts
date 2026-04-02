export type OversizedTransferCommon = {
  type: 'oversized-transfer';
  frameType: 'start' | 'end' | 'chunk' | 'accept' | 'abort';
};

export type StartFrame = OversizedTransferCommon & {
  frameType: 'start';
  completionMode: 'render';
  digest: string;
  totalBytes: number;
  totalChunks: number;
};

export type AcceptFrame = OversizedTransferCommon & {
  frameType: 'accept';
};

/** `data` is one ordered fragment of the serialized JSON-RPC string. */
export type ChunkFrame = OversizedTransferCommon & {
  frameType: 'chunk';
  data: string;
};

export type EndFrame = OversizedTransferCommon & {
  frameType: 'end';
};

export type AbortFrame = OversizedTransferCommon & {
  frameType: 'abort';
  reason?: string;
};

export type OversizedTransferFrame =
  | StartFrame
  | AcceptFrame
  | ChunkFrame
  | EndFrame
  | AbortFrame;

/**
 * Shape of a `notifications/progress` params object that carries
 * a CEP-22 oversized-transfer frame inside the `cvm` extension field.
 */
export type OversizedTransferProgress = {
  progressToken: string | number;
  progress: number;
  message?: string;
  total?: number;
  cvm: OversizedTransferFrame;
};
