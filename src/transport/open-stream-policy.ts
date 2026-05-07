/**
 * Shared policy options for CEP-41 open-stream lifecycle and buffering.
 */
export interface OpenStreamTransportPolicy {
  maxConcurrentStreams?: number;
  maxBufferedChunksPerStream?: number;
  maxBufferedBytesPerStream?: number;
  idleTimeoutMs?: number;
  probeTimeoutMs?: number;
  closeGracePeriodMs?: number;
}
