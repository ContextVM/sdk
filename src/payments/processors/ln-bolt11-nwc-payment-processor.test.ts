import { describe, expect, test } from 'bun:test';

import type { RelayHandler } from '../../core/interfaces.js';
import type { NwcConnection } from '../nip47/types.js';
import type { PaymentProcessorVerifyParams } from '../types.js';

type NwcRequestCall = {
  method: string;
  request: { method: string; params: unknown };
  resultType: string;
};

class MockNwcClient {
  public calls: NwcRequestCall[] = [];

  public responses: Array<unknown> = [];

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
}

let mockClient: MockNwcClient | undefined;

// Mock the connection parser so tests don't depend on URI parsing behavior.
await import('bun:test').then(({ mock }) => {
  mock.module('../nip47/connection.js', () => {
    return {
      parseNwcConnectionString(_s: string): NwcConnection {
        return {
          walletPubkey: 'f'.repeat(64),
          relays: ['wss://relay.example'],
          clientSecretKeyHex: '0'.repeat(64),
        };
      },
    };
  });

  // Mock NwcClient so we can deterministically control request/response.
  mock.module('../nip47/nwc-client.js', () => {
    return {
      NwcClient: class {
        public constructor(_options: {
          relayHandler: RelayHandler;
          connection: NwcConnection;
          responseTimeoutMs?: number;
        }) {
          mockClient = new MockNwcClient();
        }

        public async request<M extends string, P, R>(params: {
          method: M;
          request: { method: M; params: P };
          resultType: M;
        }): Promise<R> {
          if (!mockClient) throw new Error('MockNwcClient not initialized');
          return await mockClient.request(params);
        }
      },
    };
  });
});

const { LnBolt11NwcPaymentProcessor } =
  await import('./ln-bolt11-nwc-payment-processor.js');

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
    const processor = new LnBolt11NwcPaymentProcessor({
      nwcConnectionString: 'nostr+walletconnect://test',
    });

    // One lookup that is immediately settled.
    mockClient!.responses.push({
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
    expect(mockClient!.calls).toHaveLength(1);
    expect(mockClient!.calls[0]!.method).toBe('lookup_invoice');
  });

  test('prefers lookup by payment_hash when wallet provided it on make_invoice', async () => {
    const processor = new LnBolt11NwcPaymentProcessor({
      nwcConnectionString: 'nostr+walletconnect://test',
    });

    mockClient!.responses.push({
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

    mockClient!.responses.push({
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
    expect(mockClient!.calls).toHaveLength(2);
    const lookup = mockClient!.calls[1]!;
    expect(lookup.method).toBe('lookup_invoice');
    expect(lookup.request.params).toEqual({ payment_hash: 'b'.repeat(64) });
  });
});
