import { describe, expect, test } from 'bun:test';
import { withServerPayments } from './server-transport-payments.js';
import type { NostrServerTransport } from '../transport/nostr-server-transport.js';

describe('withServerPayments registration guard', () => {
  function makeStubTransport(): {
    stub: NostrServerTransport;
    inboundCount: () => number;
  } {
    let inbound = 0;
    const stub = {
      setAnnouncementExtraTags: () => {},
      setAnnouncementPricingTags: () => {},
      setSupportedPaymentInteraction: () => {},
      addInboundMiddleware: () => {
        inbound += 1;
      },
    } as unknown as NostrServerTransport;
    return { stub, inboundCount: () => inbound };
  }

  const options = {
    processors: [
      {
        pmi: 'fake',
        async createPaymentRequired() {
          return {
            amount: 1,
            pay_req: 'pay_req',
            pmi: 'fake',
            ttl: 300,
          };
        },
        async verifyPayment() {
          return { _meta: {} };
        },
      },
    ],
    pricedCapabilities: [],
    paymentInteraction: 'optional' as const,
  };

  test('registers the payments middleware pair exactly once on first call', () => {
    const { stub, inboundCount } = makeStubTransport();
    withServerPayments(stub, options);
    // 'optional' policy registers the transparent + explicit-gating pair.
    expect(inboundCount()).toBe(2);
  });

  test('refuses double registration instead of double-charging', () => {
    const { stub } = makeStubTransport();
    withServerPayments(stub, options);
    expect(() => withServerPayments(stub, options)).toThrow(
      /already called on this transport/,
    );
  });

  test('different transports register independently', () => {
    const a = makeStubTransport();
    const b = makeStubTransport();
    withServerPayments(a.stub, options);
    expect(() => withServerPayments(b.stub, options)).not.toThrow();
  });
});
