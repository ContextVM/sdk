/** Runtime-neutral HTTP contract; callers may inject a Web Fetch implementation. */
export type PaymentFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Optional cancellation and absolute wall-clock deadline for provider operations. */
export interface PaymentOperationContext {
  abortSignal?: AbortSignal;
  deadlineMs?: number;
}

/** Runs provider work with cancellation, a bounded wait, and unconditional cleanup. */
export async function runPaymentOperation<T>(
  context: PaymentOperationContext,
  timeoutMs: number,
  shutdownSignal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const operation = paymentOperation(context, timeoutMs, shutdownSignal);
  try {
    operation.signal.throwIfAborted();
    return await operation.wait(run(operation.signal));
  } finally {
    operation.dispose();
  }
}

/** Owns a bounded operation; abort means the remote outcome may still be unknown. */
export function paymentOperation(
  context: PaymentOperationContext = {},
  timeoutMs = 60_000,
  shutdownSignal?: AbortSignal,
): {
  signal: AbortSignal;
  wait: <T>(promise: Promise<T>) => Promise<T>;
  dispose: () => void;
} {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647 ||
    (context.deadlineMs !== undefined &&
      (!Number.isSafeInteger(context.deadlineMs) || context.deadlineMs < 0))
  )
    throw new TypeError('Invalid payment operation deadline');
  const controller = new AbortController();
  const abort = (): void =>
    controller.abort(new Error('Payment operation aborted'));
  const signals = [context.abortSignal, shutdownSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  for (const signal of signals) {
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }
  const delay = Math.min(
    timeoutMs,
    (context.deadlineMs ?? Infinity) - Date.now(),
  );
  const timer = setTimeout(abort, Math.max(0, delay));
  if (delay <= 0) abort();
  return {
    signal: controller.signal,
    wait: async <T>(promise: Promise<T>): Promise<T> => {
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = (): void =>
          reject(new Error('Payment operation aborted or timed out'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      try {
        return await Promise.race([promise, aborted]);
      } finally {
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      }
    },
    dispose: (): void => {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', abort);
      abort();
    },
  };
}
