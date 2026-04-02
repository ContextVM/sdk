export const OVERSIZED_TRANSFER_TYPE = 'oversized-transfer';

/**
 * Conservative proactive threshold for switching to framed transfer.
 *
 * This is lower than common relay payload limits to leave room for
 * Nostr envelope serialization overhead and tags.
 */
export const DEFAULT_OVERSIZED_THRESHOLD_BYTES = 48_000;

/**
 * Maximum UTF-8 bytes in each framed chunk payload.
 *
 * Kept deliberately below the threshold to account for escaping overhead in
 * the nested JSON string carried by notifications/progress.
 */
export const DEFAULT_CHUNK_SIZE_BYTES = 24_000;

export const DIGEST_PREFIX = 'sha256:';

/** Maximum accepted total payload size for one transfer. */
export const DEFAULT_MAX_TRANSFER_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Maximum accepted chunk count for one transfer. */
export const DEFAULT_MAX_TRANSFER_CHUNKS = 10_000;

/** Hard timeout for one in-flight transfer. */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;

/** Max number of concurrent in-flight transfers per receiver instance. */
export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 64;
