import type {
  JSONRPCMessage,
  JSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';

export type OversizedTransferFrameType =
  | 'start'
  | 'accept'
  | 'chunk'
  | 'end'
  | 'abort';

export type OversizedTransferCommonFrame = {
  type: 'oversized-transfer';
  frameType: OversizedTransferFrameType;
};

export type OversizedTransferStartFrame = OversizedTransferCommonFrame & {
  frameType: 'start';
  completionMode: 'render';
  digest: string;
  totalBytes: number;
  totalChunks: number;
};

export type OversizedTransferAcceptFrame = OversizedTransferCommonFrame & {
  frameType: 'accept';
};

export type OversizedTransferChunkFrame = OversizedTransferCommonFrame & {
  frameType: 'chunk';
  data: string;
};

export type OversizedTransferEndFrame = OversizedTransferCommonFrame & {
  frameType: 'end';
};

export type OversizedTransferAbortFrame = OversizedTransferCommonFrame & {
  frameType: 'abort';
  reason?: string;
};

export type OversizedTransferFrame =
  | OversizedTransferStartFrame
  | OversizedTransferAcceptFrame
  | OversizedTransferChunkFrame
  | OversizedTransferEndFrame
  | OversizedTransferAbortFrame;

export type OversizedTransferProgressParams = {
  progressToken: string | number;
  progress: number;
  message?: string;
  total?: number;
  cvm: OversizedTransferFrame;
};

export type OversizedTransferProgressNotification = JSONRPCNotification & {
  method: 'notifications/progress';
  params: OversizedTransferProgressParams;
};

export type OversizedTransferFrameParseResult = {
  token: string;
  progress: number;
  frame: OversizedTransferFrame;
};

export type OversizedTransferSyntheticResult = JSONRPCMessage | null;
