import type {
  OpenStreamAbortFrame,
  OpenStreamAcceptFrame,
  OpenStreamChunkFrame,
  OpenStreamCloseFrame,
  OpenStreamPingFrame,
  OpenStreamPongFrame,
  OpenStreamProgress,
  OpenStreamStartFrame,
} from './types.js';

export function buildOpenStreamStartFrame(params: {
  progressToken: string;
  progress: number;
  contentType?: string;
}): OpenStreamProgress {
  const cvm: OpenStreamStartFrame = {
    type: 'open-stream',
    frameType: 'start',
    contentType: params.contentType,
  };

  return {
    progressToken: params.progressToken,
    progress: params.progress,
    cvm,
  };
}

export function buildOpenStreamAcceptFrame(params: {
  progressToken: string;
  progress: number;
}): OpenStreamProgress {
  const cvm: OpenStreamAcceptFrame = {
    type: 'open-stream',
    frameType: 'accept',
  };

  return {
    progressToken: params.progressToken,
    progress: params.progress,
    cvm,
  };
}

export function buildOpenStreamChunkFrame(params: {
  progressToken: string;
  progress: number;
  chunkIndex: number;
  data: string;
}): OpenStreamProgress {
  const cvm: OpenStreamChunkFrame = {
    type: 'open-stream',
    frameType: 'chunk',
    chunkIndex: params.chunkIndex,
    data: params.data,
  };

  return {
    progressToken: params.progressToken,
    progress: params.progress,
    cvm,
  };
}

export function buildOpenStreamPingFrame(params: {
  progressToken: string;
  progress: number;
  nonce: string;
}): OpenStreamProgress {
  const cvm: OpenStreamPingFrame = {
    type: 'open-stream',
    frameType: 'ping',
    nonce: params.nonce,
  };

  return {
    progressToken: params.progressToken,
    progress: params.progress,
    cvm,
  };
}

export function buildOpenStreamPongFrame(params: {
  progressToken: string;
  progress: number;
  nonce: string;
}): OpenStreamProgress {
  const cvm: OpenStreamPongFrame = {
    type: 'open-stream',
    frameType: 'pong',
    nonce: params.nonce,
  };

  return {
    progressToken: params.progressToken,
    progress: params.progress,
    cvm,
  };
}

export function buildOpenStreamCloseFrame(params: {
  progressToken: string;
  progress: number;
  lastChunkIndex?: number;
}): OpenStreamProgress {
  const cvm: OpenStreamCloseFrame = {
    type: 'open-stream',
    frameType: 'close',
    lastChunkIndex: params.lastChunkIndex,
  };

  return {
    progressToken: params.progressToken,
    progress: params.progress,
    cvm,
  };
}

export function buildOpenStreamAbortFrame(params: {
  progressToken: string;
  progress: number;
  reason?: string;
}): OpenStreamProgress {
  const cvm: OpenStreamAbortFrame = {
    type: 'open-stream',
    frameType: 'abort',
    reason: params.reason,
  };

  return {
    progressToken: params.progressToken,
    progress: params.progress,
    cvm,
  };
}
