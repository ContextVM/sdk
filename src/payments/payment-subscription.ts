import type { Filter, NostrEvent } from 'nostr-tools';
import type { RelayHandler } from '../core/interfaces.js';

/** Owns one subscription until abort, including setup that resolves after cancellation. */
export async function subscribePaymentEvents(
  relay: RelayHandler,
  filters: Filter[],
  signal: AbortSignal,
  onEvent: (event: NostrEvent) => void,
  onEose?: () => void,
): Promise<void> {
  signal.throwIfAborted();
  let release: (() => void) | undefined;
  const stop = (): void => {
    signal.removeEventListener('abort', stop);
    const unsubscribe = release;
    release = undefined;
    try {
      unsubscribe?.();
    } catch {
      /* Cleanup must not replace a payment's outcome. */
    }
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    release = await relay.subscribe(
      filters,
      (event) => {
        if (!signal.aborted) onEvent(event);
      },
      onEose,
    );
    if (signal.aborted) stop();
  } catch (error) {
    stop();
    throw error;
  }
}
