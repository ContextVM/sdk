import { beforeEach, describe, expect, test } from 'bun:test';

import type { NwcConnection } from '../nip47/types.js';
import type { PaymentProcessorVerifyParams } from '../types.js';
import {
  LnBolt11NwcPaymentProcessor,
  type NwcClientLike,
} from './ln-bolt11-nwc-payment-processor.js';

type NwcRequestCall = {
  method: string;
  request: { method: string; params: unknown };
  resultType: string;
};

class MockNwcClient implements NwcClientLike {
  public calls: NwcRequestCall[] = [];

  public responses: Array<unknown> = [];

  public infoNotificationTypes: ReadonlySet<string> = new Set();
  public infoFetchCalls = 0;

  public onNotification:
    | ((payload: { notification_type: string; notification: unknown }) => void)
    | undefined;

  public subscribeCalls = 0;
  /** When set, subscribeNotifications() resolves only after this delay (ms). */
  public subscribeDelayMs = 0;

  public async request<M extends string, P, R>(params: {
    method: M;
    request: { method: M; params: P };
    resultType: M;
  }): Promise<R> {
    this.calls.push({
      method: params.method,
      request: params.request as { method: string; params: unknown },
      resultType: params.resultType,
    });
    if (this.responses.length === 0) {
      throw new Error('MockNwcClient has no responses queued');
    }
    return this.responses.shift() as R;
  }

  public async fetchInfoNotificationTypes(): Promise<ReadonlySet<string>> {
    this.infoFetchCalls += 1;
    return this.infoNotificationTypes;
  }

  public async subscribeNotifications(params: {
    onNotification: (payload: {
      notification_type: string;
      notification: unknown;
    }) => void;
  }): Promise<() => void> {
    this.subscribeCalls += 1;
    if (this.subscribeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.subscribeDelayMs));
    }
    this.onNotification = params.onNotification;
    return () => {
      this.onNotification = undefined;
    };
  }
}

let mockClient: MockNwcClient;

const mockConnection: NwcConnection = {
  walletPubkey: 'f'.repeat(64),
  relays: ['wss://relay.example'],
  clientSecretKeyHex: '0'.repeat(64),
};

beforeEach(() => {
  mockClient = new MockNwcClient();
});

function createProcessor(
  options: Omit<
    ConstructorParameters<typeof LnBolt11NwcPaymentProcessor>[0],
    'nwcConnectionString' | 'connection' | 'nwcClient'
  > = {},
): LnBolt11NwcPaymentProcessor {
  return new LnBolt11NwcPaymentProcessor({
    nwcConnectionString: 'nostr+walletconnect://test',
    connection: mockConnection,
    nwcClient: mockClient,
    ...options,
  });
}

function makeVerifyParams(params: {
  payReq: string;
  requestEventId?: string;
}): PaymentProcessorVerifyParams {
  return {
    pay_req: params.payReq,
    requestEventId:
      params.requestEventId ?? 'req_' + Math.random().toString(16),
    clientPubkey: 'c'.repeat(64),
  };
}

describe('LnBolt11NwcPaymentProcessor', () => {
  test('dedupes concurrent verifyPayment for the same invoice', async () => {
    // Captured per test: under bun --concurrent, beforeEach swaps the module
    // binding while other tests are in flight — reads after an await must use
    // this snapshot, not the live `mockClient`.
    const client = mockClient;
    const processor = createProcessor();

    // One lookup that is immediately settled.
    client.responses.push({
      result_type: 'lookup_invoice',
      error: null,
      result: {
        state: 'settled',
        payment_hash: 'a'.repeat(64),
      },
    });

    const verifyParams = makeVerifyParams({
      payReq: 'lnbc1invoice',
      requestEventId: 'req_dedupe',
    });

    const [a, b] = await Promise.all([
      processor.verifyPayment(verifyParams),
      processor.verifyPayment(verifyParams),
    ]);

    expect(a).toEqual({ _meta: { payment_hash: 'a'.repeat(64) } });
    expect(b).toEqual({ _meta: { payment_hash: 'a'.repeat(64) } });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe('lookup_invoice');
  });

  test('prefers lookup by payment_hash when wallet provided it on make_invoice', async () => {
    const client = mockClient;
    const processor = createProcessor();

    client.responses.push({
      result_type: 'make_invoice',
      error: null,
      result: {
        invoice: 'lnbc1cached',
        payment_hash: 'b'.repeat(64),
      },
    });

    await processor.createPaymentRequired({
      amount: 1,
      requestEventId: 'req_make',
      clientPubkey: 'c'.repeat(64),
      description: 'x',
    });

    client.responses.push({
      result_type: 'lookup_invoice',
      error: null,
      result: {
        state: 'settled',
        payment_hash: 'b'.repeat(64),
      },
    });

    await processor.verifyPayment(
      makeVerifyParams({ payReq: 'lnbc1cached', requestEventId: 'req_verify' }),
    );

    // Calls: make_invoice, lookup_invoice
    expect(client.calls).toHaveLength(2);
    const lookup = client.calls[1]!;
    expect(lookup.method).toBe('lookup_invoice');
    expect(lookup.request.params).toEqual({ payment_hash: 'b'.repeat(64) });
  });

  test('auto mode fetches info once and uses polling when notifications not supported', async () => {
    const client = mockClient;
    const processor = createProcessor({
      enableNotificationVerification: undefined,
    });

    client.infoNotificationTypes = new Set();

    client.responses.push({
      result_type: 'lookup_invoice',
      error: null,
      result: { state: 'settled', payment_hash: 'c'.repeat(64) },
    });

    await processor.verifyPayment(
      makeVerifyParams({ payReq: 'lnbc1invoice', requestEventId: 'req_auto' }),
    );

    expect(client.infoFetchCalls).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.method).toBe('lookup_invoice');
  });

  test('notification mode resolves verifyPayment from payment_received notification', async () => {
    const client = mockClient;
    const processor = createProcessor({
      enableNotificationVerification: true,
    });

    client.responses.push({
      result_type: 'make_invoice',
      error: null,
      result: {
        invoice: 'lnbc1notify',
        payment_hash: 'd'.repeat(64),
      },
    });

    const pr = await processor.createPaymentRequired({
      amount: 1,
      requestEventId: 'req_make_notify',
      clientPubkey: 'c'.repeat(64),
      description: 'x',
    });

    const verifyPromise = processor.verifyPayment(
      makeVerifyParams({
        payReq: pr.pay_req,
        requestEventId: 'req_verify_notify',
      }),
    );

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(client.calls).toHaveLength(1); // only make_invoice

    client.onNotification?.({
      notification_type: 'payment_received',
      notification: { payment_hash: 'd'.repeat(64) },
    });

    await expect(verifyPromise).resolves.toEqual({
      _meta: { payment_hash: 'd'.repeat(64) },
    });
  });

  test('concurrent verifies subscribe for notifications exactly once', async () => {
    const client = mockClient;
    const processor = createProcessor({
      enableNotificationVerification: true,
    });
    client.subscribeDelayMs = 30;

    // Two distinct invoices, both with cached payment hashes.
    for (const invoice of ['lnbc1race1', 'lnbc1race2']) {
      client.responses.push({
        result_type: 'make_invoice',
        error: null,
        result: { invoice, payment_hash: invoice.padEnd(64, '0').slice(0, 64) },
      });
      await processor.createPaymentRequired({
        amount: 1,
        requestEventId: 'req_' + invoice,
        clientPubkey: 'c'.repeat(64),
        description: 'x',
      });
    }

    const controller = new AbortController();
    const mkVerify = (
      payReq: string,
      requestEventId: string,
    ): PaymentProcessorVerifyParams => ({
      pay_req: payReq,
      requestEventId,
      clientPubkey: 'c'.repeat(64),
      abortSignal: controller.signal,
    });

    const verifies = Promise.allSettled([
      processor.verifyPayment(mkVerify('lnbc1race1', 'v1')),
      processor.verifyPayment(mkVerify('lnbc1race2', 'v2')),
    ]);

    // Abort while both verifies still await the (delayed) subscription, so
    // both reject instead of waiting for notifications that never come.
    setTimeout(() => controller.abort(), 10);
    const results = await verifies;

    expect(
      results.every((r) => r.status === 'rejected'),
    ).toBe(true);
    // The concurrent subscribe window must produce exactly one subscription;
    // a second would leak its unsubscribe handle forever.
    expect(client.subscribeCalls).toBe(1);
  });
});
