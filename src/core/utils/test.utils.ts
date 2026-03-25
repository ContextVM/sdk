import { sleep } from './utils.js';

export async function waitFor<T>(params: {
  produce: () => T | undefined;
  predicate?: (value: T) => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 5_000;
  const intervalMs = params.intervalMs ?? 25;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = params.produce();
    if (value !== undefined && (params.predicate?.(value) ?? true)) {
      return value;
    }
    await sleep(intervalMs);
  }

  throw new Error('Timed out waiting for expected test condition');
}
