import type { PaymentProcessor, PmiTag } from './types.js';

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
