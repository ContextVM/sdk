import { describe, expect, test } from 'bun:test';
import type { JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import { createServerPaymentsMiddleware } from './server-payments.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import type {
  CorrelatedNotificationSender,
  PaymentProcessor,
  PaymentRequired,
  PricedCapability,
} from './types.js';

const PRICED: PricedCapability = {
  method: 'tools/call',
  name: 'expensive_tool',
  amount: 1000,
  currencyUnit: 'millisats',
};

interface FakeProcessorOptions {
  /** Verification behavior once the invoice has been issued. */
  verify: 'hang' | 'resolve' | 'throw';
  verifyDelayMs?: number;
}

interface ProcessorSpy {
  processor: PaymentProcessor;
  /** pay_req values minted per request event id, in order. */
  invoicesByEvent: Map<string, string[]>;
}

function makeProcessor(opts: FakeProcessorOptions): ProcessorSpy {
  let n = 0;
  const invoicesByEvent = new Map<string, string[]>();
  const processor: PaymentProcessor = {
    pmi: 'test-pmi',
    async createPaymentRequired(params) {
      n += 1;
      const payReq = `invoice-${n}`;
      const list = invoicesByEvent.get(params.requestEventId) ?? [];
      list.push(payReq);
      invoicesByEvent.set(params.requestEventId, list);
      const required: PaymentRequired = {
        amount: params.amount,
        pay_req: payReq,
        pmi: 'test-pmi',
      };
      return required;
    },
    async verifyPayment(params) {
      void params;
      await new Promise((r) => setTimeout(r, opts.verifyDelayMs ?? 20));
      if (opts.verify === 'throw') {
        throw new Error('payment rail unreachable');
      }
      if (opts.verify === 'hang') {
        // Never settles: withTimeout turns this into a verification timeout.
        await new Promise<void>(() => {});
      }
      return {};
    },
  };
  return { processor, invoicesByEvent };
}

interface SenderSpy {
  sender: CorrelatedNotificationSender;
  methods: string[];
  notifications: Array<{ method: string; params: Record<string, unknown> }>;
}

function makeSender(failOnMethod?: string): SenderSpy {
  const methods: string[] = [];
  const notifications: SenderSpy['notifications'] = [];
  const sender: CorrelatedNotificationSender = {
    async sendNotification(_pubkey, notification, _eventId) {
      methods.push(notification.method);
      notifications.push({
        method: notification.method,
        params: notification.params as Record<string, unknown>,
      });
      if (notification.method === failOnMethod) {
        throw new Error('publish failed');
      }
    },
  };
  return { sender, methods, notifications };
}

interface MiddlewareHarness {
  run: (requestEventId: string) => Promise<void>;
  forwards: () => number;
  invoiceCount: (requestEventId: string) => number;
}

function buildHarness(
  spy: ProcessorSpy,
  sender: CorrelatedNotificationSender,
  extraOptions?: Partial<ServerPaymentsOptions>,
  onInvoiceIssued?: (params: {
    requestEventId: string;
    snapshotTtlMs: number;
  }) => void,
): MiddlewareHarness {
  let forwards = 0;
  const middleware = createServerPaymentsMiddleware({
    sender,
    options: {
      processors: [spy.processor],
      pricedCapabilities: [PRICED],
      ...extraOptions,
    },
    onInvoiceIssued,
  });
  const request = (id: string): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'expensive_tool' },
  });
  return {
    run: (id) =>
      middleware(request(id), { clientPubkey: 'client' }, async () => {
        forwards += 1;
      }),
    forwards: () => forwards,
    invoiceCount: (id) => (spy.invoicesByEvent.get(id) ?? []).length,
  };
}

describe('createServerPaymentsMiddleware pending-payment retention', () => {
  test('payment-rail failure after invoice issuance keeps the entry, so redelivery does not mint a second invoice', async () => {
    const spy = makeProcessor({ verify: 'throw', verifyDelayMs: 20 });
    const { sender } = makeSender();
    const harness = buildHarness(spy, sender, { paymentTtlMs: 5000 });

    await expect(harness.run('evt1')).rejects.toThrow(
      'payment rail unreachable',
    );
    expect(harness.invoiceCount('evt1')).toBe(1);

    // Redelivery of the same request event while the entry is within its TTL:
    // the duplicate awaits the (rejected) in-flight lifecycle instead of
    // minting a second invoice. (After TTL expiry a retry re-invoices by
    // design — idempotency is TTL-bounded.)
    await expect(harness.run('evt1')).rejects.toThrow(
      'payment rail unreachable',
    );
    expect(harness.invoiceCount('evt1')).toBe(1);
  });

  test('pre-invoice failure deletes the entry, so the retry mints exactly one invoice', async () => {
    const spy = makeProcessor({ verify: 'resolve' });
    const { sender } = makeSender();
    let quotes = 0;
    const harness = buildHarness(spy, sender, {
      paymentTtlMs: 5000,
      resolvePrice: async () => {
        quotes += 1;
        if (quotes === 1) {
          throw new Error('pricing backend down');
        }
        return { amount: 1000 };
      },
    });

    await expect(harness.run('evt1')).rejects.toThrow('pricing backend down');
    expect(harness.invoiceCount('evt1')).toBe(0);

    await harness.run('evt1');
    expect(harness.invoiceCount('evt1')).toBe(1);
    expect(harness.forwards()).toBe(1);
  });

  test('redelivery after success neither re-invoices nor double-forwards', async () => {
    const spy = makeProcessor({ verify: 'resolve' });
    const { sender } = makeSender();
    const harness = buildHarness(spy, sender, { paymentTtlMs: 5000 });

    await harness.run('evt1');
    await harness.run('evt1');

    expect(harness.invoiceCount('evt1')).toBe(1);
    expect(harness.forwards()).toBe(1);
  });
});

describe('createServerPaymentsMiddleware payment_accepted publish failure', () => {
  test('forwards the request anyway: the result is the point, not the SHOULD notification', async () => {
    const spy = makeProcessor({ verify: 'resolve' });
    const { sender } = makeSender('notifications/payment_accepted');
    const harness = buildHarness(spy, sender, { paymentTtlMs: 5000 });

    // Resolves (no throw): the publish failure is logged, the forward happens.
    await harness.run('evt1');
    expect(harness.forwards()).toBe(1);

    // Entry was retained (post-invoice): redelivery must not re-invoice.
    await harness.run('evt1');
    expect(harness.invoiceCount('evt1')).toBe(1);
    expect(harness.forwards()).toBe(1);
  });
});

describe('createServerPaymentsMiddleware pending capacity', () => {
  test('refuses new priced requests at capacity without minting an invoice', async () => {
    const spy = makeProcessor({ verify: 'hang' });
    const senderSpy = makeSender();
    const harness = buildHarness(spy, senderSpy.sender, {
      paymentTtlMs: 10_000,
      maxPendingPayments: 2,
    });

    const inFlight = [
      harness.run('evt1').catch(() => {}),
      harness.run('evt2').catch(() => {}),
    ];
    await new Promise((r) => setTimeout(r, 10));

    await harness.run('evt3');

    expect(harness.invoiceCount('evt3')).toBe(0);
    expect(harness.forwards()).toBe(0);
    // Refused without charging: the client is told instead of hanging.
    expect(senderSpy.methods).toContain('notifications/payment_rejected');
    const rejection = senderSpy.notifications.find(
      (n) => n.method === 'notifications/payment_rejected',
    );
    expect(rejection?.params.pmi).toBe('test-pmi');
    void inFlight;
  });

  test('purges expired entries at capacity instead of refusing', async () => {
    const spy = makeProcessor({ verify: 'hang' });
    const { sender } = makeSender();
    const harness = buildHarness(spy, sender, {
      paymentTtlMs: 60,
      maxPendingPayments: 2,
    });

    await Promise.allSettled([harness.run('evt1'), harness.run('evt2')]);
    // Both entries have now expired.
    await new Promise((r) => setTimeout(r, 10));

    // evt3 is accepted (invoice minted) rather than refused; its own
    // verification still times out afterwards, which is fine here.
    await harness.run('evt3').catch(() => {});
    expect(harness.invoiceCount('evt3')).toBe(1);
  });

  test('maxPendingPayments 0 refuses all priced requests', async () => {
    const spy = makeProcessor({ verify: 'resolve' });
    const { sender } = makeSender();
    const harness = buildHarness(spy, sender, { maxPendingPayments: 0 });

    await harness.run('evt1');

    expect(harness.invoiceCount('evt1')).toBe(0);
    expect(harness.forwards()).toBe(0);
  });

  test('paymentTtlMs 0 falls back to the default so redelivery dedup survives', async () => {
    // A zero TTL would birth-expire the pending entry while the invoice stays
    // payable — disarming the duplicate-request dedup (CEP-8). It must fall
    // back to the default window instead.
    const spy = makeProcessor({ verify: 'throw' });
    const { sender } = makeSender();
    const harness = buildHarness(spy, sender, { paymentTtlMs: 0 });

    await expect(harness.run('evt-ttl0')).rejects.toThrow(
      'payment rail unreachable',
    );

    // Redelivery while the (paid) invoice is still outstanding: deduped by
    // the surviving pending entry, not re-invoiced.
    await expect(harness.run('evt-ttl0')).rejects.toThrow(
      'payment rail unreachable',
    );
    expect(harness.invoiceCount('evt-ttl0')).toBe(1);
  });
});

describe('createServerPaymentsMiddleware onInvoiceIssued', () => {
  test('fires when an invoice is issued, with a snapshot TTL covering the payment window', async () => {
    const spy = makeProcessor({ verify: 'resolve' });
    const { sender } = makeSender();
    const issued: Array<{ requestEventId: string; snapshotTtlMs: number }> = [];
    const harness = buildHarness(spy, sender, { paymentTtlMs: 5000 }, (p) =>
      issued.push(p),
    );

    await harness.run('evt1');

    expect(issued).toEqual([
      { requestEventId: 'evt1', snapshotTtlMs: 5000 + 60_000 },
    ]);
  });

  test('does not fire for rejections or waivers', async () => {
    const spy = makeProcessor({ verify: 'resolve' });
    const { sender } = makeSender();
    const issued: Array<{ requestEventId: string; snapshotTtlMs: number }> = [];
    const harness = buildHarness(
      spy,
      sender,
      {
        paymentTtlMs: 5000,
        resolvePrice: async () => ({ reject: true, message: 'no funds' }),
      },
      (p) => issued.push(p),
    );

    await harness.run('evt1');

    expect(issued).toEqual([]);
    expect(harness.forwards()).toBe(0);
  });
});

describe('createServerPaymentsMiddleware transport shutdown', () => {
  /** Verification the test settles by hand, after `abortSignal` fires. */
  interface DeferredVerify {
    processor: PaymentProcessor;
    started: Promise<AbortSignal | undefined>;
    resolve: () => void;
  }

  function makeDeferredProcessor(opts: {
    /** Reject on the per-request signal like the built-in processors do. */
    honorAbort: boolean;
  }): DeferredVerify {
    let onStarted!: (signal: AbortSignal | undefined) => void;
    const started = new Promise<AbortSignal | undefined>((r) => {
      onStarted = r;
    });
    let resolveVerify: () => void = () => {};
    const processor: PaymentProcessor = {
      pmi: 'test-pmi',
      async createPaymentRequired(params) {
        return { amount: params.amount, pay_req: 'invoice-1', pmi: 'test-pmi' };
      },
      verifyPayment(params) {
        onStarted(params.abortSignal);
        return new Promise((resolve, reject) => {
          resolveVerify = () => resolve({});
          if (opts.honorAbort) {
            params.abortSignal?.addEventListener(
              'abort',
              () => reject(new Error('verifyPayment aborted')),
              { once: true },
            );
          }
        });
      },
    };
    return { processor, started, resolve: () => resolveVerify() };
  }

  function buildShutdownHarness(
    processor: PaymentProcessor,
    sender: CorrelatedNotificationSender,
    abortSignal: AbortSignal,
  ): {
    run: (requestEventId: string) => Promise<void>;
    forwards: () => number;
  } {
    let forwards = 0;
    const middleware = createServerPaymentsMiddleware({
      sender,
      options: { processors: [processor], pricedCapabilities: [PRICED] },
      abortSignal,
    });
    return {
      run: (id) =>
        middleware(
          {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'expensive_tool' },
          },
          { clientPubkey: 'client' },
          async () => {
            forwards += 1;
          },
        ),
      forwards: () => forwards,
    };
  }

  function captureUnhandledRejections(): () => unknown[] {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    return () => {
      process.off('unhandledRejection', onRejection);
      return seen;
    };
  }

  test('a verify that settles after abort neither publishes payment_accepted nor forwards', async () => {
    const unhandled = captureUnhandledRejections();
    const deferred = makeDeferredProcessor({ honorAbort: false });
    const { sender, methods } = makeSender();
    const shutdown = new AbortController();
    const harness = buildShutdownHarness(
      deferred.processor,
      sender,
      shutdown.signal,
    );

    const run = harness.run('evt1');
    const perRequestSignal = await deferred.started;
    expect(perRequestSignal?.aborted).toBe(false);

    shutdown.abort();
    expect(perRequestSignal?.aborted).toBe(true);

    // Processor ignores the abort and reports success anyway.
    deferred.resolve();
    await run;

    expect(harness.forwards()).toBe(0);
    expect(methods).toEqual(['notifications/payment_required']);
    expect(unhandled()).toEqual([]);
  });

  test('abort cuts a pending verify short, the run settles cleanly, and the pending entry survives for redelivery dedup', async () => {
    const unhandled = captureUnhandledRejections();
    const deferred = makeDeferredProcessor({ honorAbort: true });
    const { sender, methods } = makeSender();
    const shutdown = new AbortController();
    const harness = buildShutdownHarness(
      deferred.processor,
      sender,
      shutdown.signal,
    );

    const run = harness.run('evt1');
    await deferred.started;
    shutdown.abort();

    // No timeout wait, no rethrow: the abort resolves the run promptly.
    let settled = false;
    await Promise.race([
      run.then(() => {
        settled = true;
      }),
      new Promise((r) => setTimeout(r, 200)),
    ]);
    expect(settled).toBe(true);
    expect(harness.forwards()).toBe(0);
    expect(methods).toEqual(['notifications/payment_required']);

    // Cancel-not-drain: the invoice stays pending until TTL, so a redelivery
    // of the same event neither mints a second invoice nor forwards.
    await harness.run('evt1');
    expect(harness.forwards()).toBe(0);
    expect(methods).toEqual(['notifications/payment_required']);
    expect(unhandled()).toEqual([]);
  });

  test('detaches its listener from the shared signal once verify settles', async () => {
    const deferred = makeDeferredProcessor({ honorAbort: false });
    const { sender } = makeSender();
    const shutdown = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const originalAdd = shutdown.signal.addEventListener.bind(shutdown.signal);
    const originalRemove = shutdown.signal.removeEventListener.bind(
      shutdown.signal,
    );
    shutdown.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type);
      return (originalAdd as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof shutdown.signal.addEventListener;
    shutdown.signal.removeEventListener = ((
      type: string,
      ...rest: unknown[]
    ) => {
      removed.push(type);
      return (originalRemove as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof shutdown.signal.removeEventListener;
    const harness = buildShutdownHarness(
      deferred.processor,
      sender,
      shutdown.signal,
    );

    const run = harness.run('evt1');
    await deferred.started;
    expect(added).toEqual(['abort']);
    expect(removed).toEqual([]);

    deferred.resolve();
    await run;

    expect(removed).toEqual(['abort']);
    expect(harness.forwards()).toBe(1);
  });

  test('a signal that never fires leaves the paid flow unchanged', async () => {
    const deferred = makeDeferredProcessor({ honorAbort: true });
    const { sender, methods } = makeSender();
    const shutdown = new AbortController();
    const harness = buildShutdownHarness(
      deferred.processor,
      sender,
      shutdown.signal,
    );

    const run = harness.run('evt1');
    await deferred.started;
    deferred.resolve();
    await run;

    expect(harness.forwards()).toBe(1);
    expect(methods).toEqual([
      'notifications/payment_required',
      'notifications/payment_accepted',
    ]);
  });
});
