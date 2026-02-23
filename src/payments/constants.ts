/**
 * Default interval for synthetic progress heartbeats.
 *
 * Chosen to be half of the upstream MCP SDK default request timeout (60s -> 30s)
 * so a heartbeat can arrive before the first timeout would fire.
 */
export const DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS = 30_000;

/**
 * Default payment TTL used for synthetic progress when `payment_required` carries no `ttl`.
 *
 * Mirrors the server-side `paymentTtlMs` default (5 minutes) so the client
 * keeps the MCP request alive for at least as long as the server will wait.
 */
export const DEFAULT_PAYMENT_TTL_MS = 300_000;

/** CEP-8 notification method: server requests payment from client. */
export const PAYMENT_REQUIRED_METHOD = 'notifications/payment_required';

/** CEP-8 notification method: server accepted payment (settlement observed). */
export const PAYMENT_ACCEPTED_METHOD = 'notifications/payment_accepted';

/** CEP-8 notification method: server rejected payment (or refused to proceed). */
export const PAYMENT_REJECTED_METHOD = 'notifications/payment_rejected';
