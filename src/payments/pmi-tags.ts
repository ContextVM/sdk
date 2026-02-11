import type { PaymentHandler, PaymentProcessor, PmiTag } from './types.js';

/**
 * Builds Nostr `pmi` tags for a set of handlers.
 *
 * Tag order is preserved and expresses client preference.
 */
export function createPmiTagsFromHandlers(
  handlers: readonly PaymentHandler[],
): PmiTag[] {
  return handlers.map((h) => ['pmi', h.pmi]);
}

/**
 * Builds Nostr `pmi` tags for a set of server-side processors.
 *
 * Tag order is preserved and expresses server preference.
 */
export function createPmiTagsFromProcessors(
  processors: readonly PaymentProcessor[],
): PmiTag[] {
  return processors.map((p) => ['pmi', p.pmi]);
}

// NOTE: PMI advertisement is handled internally by `withClientPayments()` when using
// `NostrClientTransport`. Keep tag generation helpers for discovery surfaces.
