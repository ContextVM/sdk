export type OpenStreamFrameType =
  | 'start'
  | 'accept'
  | 'chunk'
  | 'ping'
  | 'pong'
  | 'close'
  | 'abort';

export type OpenStreamCommon = {
  type: 'open-stream';
  frameType: OpenStreamFrameType;
};

export type OpenStreamStartFrame = OpenStreamCommon & {
  frameType: 'start';
  contentType?: string;
};

export type OpenStreamAcceptFrame = OpenStreamCommon & {
  frameType: 'accept';
};

export type OpenStreamChunkFrame = OpenStreamCommon & {
  frameType: 'chunk';
  chunkIndex: number;
  data: string;
};

export type OpenStreamPingFrame = OpenStreamCommon & {
  frameType: 'ping';
};

export type OpenStreamPongFrame = OpenStreamCommon & {
  frameType: 'pong';
};

export type OpenStreamCloseFrame = OpenStreamCommon & {
  frameType: 'close';
};

export type OpenStreamAbortFrame = OpenStreamCommon & {
  frameType: 'abort';
  reason?: string;
};

export type OpenStreamFrame =
  | OpenStreamStartFrame
  | OpenStreamAcceptFrame
  | OpenStreamChunkFrame
  | OpenStreamPingFrame
  | OpenStreamPongFrame
  | OpenStreamCloseFrame
  | OpenStreamAbortFrame;

export type OpenStreamProgress = {
  progressToken: string | number;
  progress: number;
  message?: string;
  total?: number;
  cvm: OpenStreamFrame;
};

export interface OpenStreamReadResult<TChunk = string> {
  readonly value: TChunk;
  readonly chunkIndex: number;
}

export interface OpenStreamSessionLike<TChunk = string> extends AsyncIterable<
  OpenStreamReadResult<TChunk>
> {
  readonly progressToken: string;
  readonly isActive: boolean;
  readonly closed: Promise<void>;
  abort(reason?: string): Promise<void>;
}
