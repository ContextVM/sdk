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
