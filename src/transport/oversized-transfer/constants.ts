export const OVERSIZED_TRANSFER_TYPE = 'oversized-transfer';

// Default per-chunk data size. Conservative: leaves ~16 KiB headroom for 64KiB Nostr event relay threshold

export const DEFAULT_CHUNK_SIZE = 48_000;

// Byte length at which the sender proactively switches to oversized transfer.
export const DEFAULT_OVERSIZED_THRESHOLD = 48_000;

// Prefix for SHA-256 digest values.
export const DIGEST_PREFIX = 'sha256:';

// Default upper bound on the total serialized payload a receiver will accept.
export const DEFAULT_MAX_ACCEPTABLE_BYTES = 100 * 1024 * 1024; // 100 MiB

// Default upper bound on the number of chunks a receiver will accept.
export const DEFAULT_MAX_TRANSFER_CHUNKS = 10_000;

// Default upper bound on concurrently active receiver-side transfers.
export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 64;

// Default hard timeout for an in-flight transfer (ms).
export const DEFAULT_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Default maximum forward gap between the next expected chunk and an
// out-of-order chunk that will still be buffered.
export const DEFAULT_MAX_OUT_OF_ORDER_WINDOW = 21;

// Default maximum number of buffered out-of-order chunks.
export const DEFAULT_MAX_OUT_OF_ORDER_CHUNKS = 42;
