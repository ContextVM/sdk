/**
 * Default interval for synthetic progress heartbeats.
 *
 * Chosen to be half of the upstream MCP SDK default request timeout (60s -> 30s)
 * so a heartbeat can arrive before the first timeout would fire.
 */
export const DEFAULT_SYNTHETIC_PROGRESS_INTERVAL_MS = 30_000;
