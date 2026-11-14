import { describe, expect, test } from 'bun:test';
import {
  PaidScenario,
  TEST_PMI,
  TRANSPORT_PROFILES,
} from '../__mocks__/cep8/paid-scenario.js';
import { cleartextMessage } from '../__mocks__/cep8/fault-relay-hub.js';
import { NOSTR_TAGS } from '../core/constants.js';
import { seedGrant } from '../__mocks__/payment-state.js';
import { computeCanonicalInvocationIdentity } from './canonical-identity.js';
import { InMemoryPaymentStateStore } from './in-memory-payment-state-store.js';
import { createExplicitGatingMiddleware } from './server-explicit-gating.js';
import type { JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from './pmis.js';
import {
  PAYMENT_ACCEPTED_METHOD,
  PAYMENT_REQUIRED_METHOD,
} from './constants.js';

const ONE_PAID_CALL = {
  prepared: 1,
  approved: 1,
  submitted: 1,
  settled: 1,
  authorized: 1,
  consumed: 1,
  dispatched: 1,
  completed: 1,
  published: 1,
  received: 1,
};

describe('CEP-8 conformance through real transports', () => {
  for (const profile of TRANSPORT_PROFILES) {
    test(`[C04] transparent: receiver settlement precedes the single paid dispatch over ${profile}`, async () => {
      const scenario = new PaidScenario({ profile });
      try {
        const client = await scenario.start();
        expect(await client.call(7)).toMatchObject({
          content: [{ type: 'text', text: '7' }],
        });
        // Relay acknowledgement and client receipt are independent events.
        await scenario.probe.reached('published');
        expect(scenario.probe.counts()).toEqual(ONE_PAID_CALL);
        expect(
          scenario.probe.ordered(
            'prepared',
            'approved',
            'submitted',
            'settled',
            'authorized',
            'consumed',
            'dispatched',
            'completed',
            'received',
          ),
        ).toBe(true);
        expect(scenario.probe.ordered('completed', 'published')).toBe(true);
      } finally {
        await scenario.close();
      }
    });

    test(`[C05] explicit gating: one approval, one claim, one dispatch over ${profile}`, async () => {
      const scenario = new PaidScenario({
        profile,
        interaction: 'explicit_gating',
      });
      try {
        const client = await scenario.start();
        expect(await client.call(9)).toMatchObject({
          content: [{ type: 'text', text: '9' }],
        });
        await scenario.probe.reached('published');
        expect(scenario.probe.counts()).toEqual(ONE_PAID_CALL);
        expect(
          scenario.probe.ordered(
            'settled',
            'authorized',
            'consumed',
            'dispatched',
          ),
        ).toBe(true);
      } finally {
        await scenario.close();
      }
    });
  }

  test('[C06] transparent payment notifications reference the original request event', async () => {
    const scenario = new PaidScenario();
    try {
      const client = await scenario.start();
      await client.call();
      const request = scenario.hub
        .accepted('client')
        .find((event) => cleartextMessage(event)?.method === 'tools/call')!;
      const notifications = scenario.hub
        .accepted('server')
        .filter((event) =>
          [PAYMENT_REQUIRED_METHOD, PAYMENT_ACCEPTED_METHOD].includes(
            cleartextMessage(event)?.method as string,
          ),
        );
      expect(notifications).toHaveLength(2);
      for (const event of notifications)
        expect(event.tags).toContainEqual(['e', request.id]);
    } finally {
      await scenario.close();
    }
  });

  test('[C03] clients send at most one payment_interaction tag per event', async () => {
    const scenario = new PaidScenario({ interaction: 'explicit_gating' });
    try {
      const client = await scenario.start();
      await client.call();
      const clientEvents = scenario.hub.accepted('client');
      expect(clientEvents.length).toBeGreaterThan(0);
      for (const event of clientEvents)
        expect(
          event.tags.filter((tag) => tag[0] === NOSTR_TAGS.PAYMENT_INTERACTION)
            .length,
        ).toBeLessThanOrEqual(1);
    } finally {
      await scenario.close();
    }
  });

  test('[C07] a claimed authorization forwards the retry original params, including _meta', async () => {
    const store = new InMemoryPaymentStateStore();
    const semantic = { name: 'paid', arguments: { value: 1 } };
    await seedGrant(
      store,
      computeCanonicalInvocationIdentity('client', 'tools/call', {
        ...semantic,
        _meta: { progressToken: 1 },
      }),
      10_000,
    );
    const retry: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'retry',
      method: 'tools/call',
      params: { ...semantic, _meta: { progressToken: 2, stream: true } },
    };
    const middleware = createExplicitGatingMiddleware({
      options: {
        processors: [],
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'paid',
            amount: 5,
            currencyUnit: 'sats',
          },
        ],
      },
      authorizationStore: store,
      sendResponse: async () => {
        throw new Error(
          'A claimed invocation must not be answered by the gate',
        );
      },
    });
    let forwarded: unknown;
    await middleware(
      retry,
      { clientPubkey: 'client', paymentInteraction: 'explicit_gating' },
      async (message) => {
        forwarded = message;
      },
    );
    expect(forwarded).toBe(retry);
    expect(retry.params).toEqual({
      ...semantic,
      _meta: { progressToken: 2, stream: true },
    });
  });

  test('[C02] built-in and test-rail PMIs satisfy the CEP-8 PMI pattern', () => {
    for (const pmi of [PMI_BITCOIN_LIGHTNING_BOLT11, TEST_PMI])
      expect(pmi).toMatch(/^[a-z0-9-]+$/);
  });
});
