import { describe, expect, test } from 'bun:test';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import {
  PaidScenario,
  TEST_PMI,
  TRANSPORT_PROFILES,
} from '../__mocks__/cep8/paid-scenario.js';
import { cleartextMessage } from '../__mocks__/cep8/fault-relay-hub.js';
import {
  PAYMENT_ACCEPTED_METHOD,
  PAYMENT_REQUIRED_ERROR_CODE,
  PAYMENT_REQUIRED_METHOD,
} from './constants.js';

const isPaidRequest = (event: NostrEvent): boolean =>
  cleartextMessage(event)?.method === 'tools/call';
const isPaidResult = (event: NostrEvent): boolean =>
  'result' in (cleartextMessage(event) ?? {}) &&
  'content' in ((cleartextMessage(event)?.result as object) ?? {});
const isMethod =
  (method: string) =>
  (event: NostrEvent): boolean =>
    cleartextMessage(event)?.method === method;

/** Lets queued microtasks and immediate timers settle without sleeping for time. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function withScenario(
  scenario: PaidScenario,
  run: (scenario: PaidScenario) => Promise<void>,
): Promise<void> {
  try {
    await run(scenario);
  } finally {
    await scenario.close();
  }
}

describe('CEP-8 delivery faults through the relay harness', () => {
  for (const profile of TRANSPORT_PROFILES) {
    test(`[F01] duplicated request deliveries create one invoice and one dispatch over ${profile}`, () =>
      withScenario(new PaidScenario({ profile }), async (scenario) => {
        const client = await scenario.start();
        scenario.hub.fault('duplicate', {
          from: 'client',
          to: 'server',
          times: 100,
        });
        await client.call();
        await scenario.probe.reached('published');
        await settle();
        expect(scenario.probe.counts()).toMatchObject({
          prepared: 1,
          submitted: 1,
          dispatched: 1,
          received: 1,
        });
      }));

    test(`[F01] duplicated offers, acknowledgements, and results cause one wallet submission over ${profile}`, () =>
      withScenario(new PaidScenario({ profile }), async (scenario) => {
        const client = await scenario.start();
        scenario.hub.fault('duplicate', {
          from: 'server',
          to: 'client',
          times: 100,
        });
        await client.call();
        await settle();
        expect(scenario.probe.counts()).toMatchObject({
          approved: 1,
          submitted: 1,
          dispatched: 1,
          received: 1,
        });
      }));

    test(`[F10] relay history replay after completion never charges or executes again over ${profile}`, () =>
      withScenario(new PaidScenario({ profile }), async (scenario) => {
        const client = await scenario.start();
        await client.call();
        await scenario.probe.reached('published');
        // Same transport: reconnect replays history through the live subscription.
        scenario.hub.disconnect('server');
        scenario.hub.reconnect('server');
        // Recreated transport: deduplication memory is gone (#105); the store remains.
        await scenario.restartServer();
        scenario.hub.replay('server', { from: 'client' });
        await settle();
        expect(scenario.probe.replays).toBeGreaterThan(0);
        expect(scenario.probe.counts()).toMatchObject({
          prepared: 1,
          submitted: 1,
          settled: 1,
          consumed: 1,
          dispatched: 1,
        });
      }));
  }

  test('[F02] a late acceptance after the result neither fails nor repeats the request', () =>
    withScenario(new PaidScenario(), async (scenario) => {
      const client = await scenario.start();
      const accepted = scenario.hub.fault('hold', {
        from: 'server',
        to: 'client',
        match: isMethod(PAYMENT_ACCEPTED_METHOD),
      });
      const result = await client.call(3);
      expect(result.content).toEqual([{ type: 'text', text: '3' }]);
      accepted.release();
      await settle();
      expect(accepted.hits).toBe(1);
      expect(scenario.probe.counts()).toMatchObject({
        submitted: 1,
        dispatched: 1,
        received: 1,
      });
    }));

  test('[F03] a request rejected before relay acceptance is a definite failure', () =>
    withScenario(new PaidScenario(), async (scenario) => {
      const client = await scenario.start();
      scenario.hub.fault('reject', { from: 'client', match: isPaidRequest });
      await expect(client.call(1, 2000)).rejects.toThrow();
      expect(scenario.probe.count('prepared')).toBe(0);
      // A definite failure does not block a genuinely new invocation.
      await client.call(2);
      expect(scenario.probe.counts()).toMatchObject({
        prepared: 1,
        submitted: 1,
        dispatched: 1,
      });
    }));

  test('[F03] a lost acceptance acknowledgement leaves admission uncertain; replay never re-invoices', () =>
    withScenario(new PaidScenario(), async (scenario) => {
      const client = await scenario.start();
      scenario.hub.fault('lose_ack', { from: 'client', match: isPaidRequest });
      await expect(client.call(1, 2000)).rejects.toThrow();
      // Unlike a rejection, the relay accepted the event and the server acted on it.
      await scenario.probe.reached('prepared');
      scenario.hub.disconnect('server');
      scenario.hub.reconnect('server');
      await scenario.restartServer();
      scenario.hub.replay('server', { from: 'client' });
      await settle();
      expect(scenario.probe.replays).toBeGreaterThan(0);
      expect(scenario.probe.counts()).toMatchObject({
        prepared: 1,
        submitted: 0,
        dispatched: 0,
      });
    }));

  test('[F06] a lost paid result is recovered from the retained record without repayment', () =>
    withScenario(new PaidScenario(), async (scenario) => {
      const client = await scenario.start();
      const lost = scenario.hub.fault('drop', {
        from: 'server',
        to: 'client',
        match: isPaidResult,
      });
      const pending = client.call(4, 15_000);
      await lost.hit();
      await scenario.restartServer();
      scenario.hub.replay('server', { from: 'client' });
      expect((await pending).content).toEqual([{ type: 'text', text: '4' }]);
      expect(scenario.probe.replays).toBeGreaterThan(0);
      expect(scenario.probe.counts()).toMatchObject({
        prepared: 1,
        submitted: 1,
        consumed: 1,
        dispatched: 1,
        received: 1,
      });
    }));

  test('[F11] payment offers from a non-server key are ignored at ingress', () =>
    withScenario(new PaidScenario(), async (scenario) => {
      const client = await scenario.start();
      const offer = scenario.hub.fault('hold', {
        from: 'server',
        to: 'client',
        match: isMethod(PAYMENT_REQUIRED_METHOD),
      });
      const pending = client.call(5);
      await offer.hit();
      const request = await scenario.hub.published({
        from: 'client',
        match: isPaidRequest,
      });
      const forged = finalizeEvent(
        {
          kind: 25910,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', client.pubkey],
            ['e', request.id],
          ],
          content: JSON.stringify({
            jsonrpc: '2.0',
            method: PAYMENT_REQUIRED_METHOD,
            params: { amount: 5, pmi: TEST_PMI, pay_req: 'attacker-invoice' },
          }),
        },
        generateSecretKey(),
      );
      await scenario.hub.createRelayHandler('attacker').publish(forged);
      await settle();
      expect(scenario.probe.count('submitted')).toBe(0);
      offer.release();
      await pending;
      expect(scenario.probe.counts()).toMatchObject({
        approved: 1,
        submitted: 1,
        dispatched: 1,
      });
    }));

  test('[F11] a malformed server offer fails the request before approval or wallet work', () =>
    withScenario(new PaidScenario(), async (scenario) => {
      const client = await scenario.start();
      const offer = scenario.hub.fault('drop', {
        from: 'server',
        to: 'client',
        match: isMethod(PAYMENT_REQUIRED_METHOD),
      });
      const pending = client.call(6, 5000);
      await offer.hit();
      const request = await scenario.hub.published({
        from: 'client',
        match: isPaidRequest,
      });
      await scenario.hub.createRelayHandler('server-key').publish(
        scenario.signAsServer(
          {
            jsonrpc: '2.0',
            method: PAYMENT_REQUIRED_METHOD,
            params: { amount: -1, pmi: TEST_PMI, pay_req: '' },
          },
          [
            ['p', client.pubkey],
            ['e', request.id],
          ],
        ),
      );
      await expect(pending).rejects.toThrow('Invalid payment message');
      expect(scenario.probe.counts()).toMatchObject({
        approved: 0,
        submitted: 0,
        dispatched: 0,
      });
    }));

  test('[F11] oversized explicit payment options are refused at ingress before approval', () =>
    withScenario(
      new PaidScenario({ interaction: 'explicit_gating' }),
      async (scenario) => {
        const client = await scenario.start();
        const gate = scenario.hub.fault('drop', {
          from: 'server',
          to: 'client',
          match: (event) =>
            (cleartextMessage(event)?.error as { code?: number } | undefined)
              ?.code === PAYMENT_REQUIRED_ERROR_CODE,
        });
        const pending = client.call(8, 5000);
        await gate.hit();
        const request = await scenario.hub.published({
          from: 'client',
          match: isPaidRequest,
        });
        const option = { amount: 5, pmi: TEST_PMI, pay_req: 'invoice' };
        await scenario.hub.createRelayHandler('server-key').publish(
          scenario.signAsServer(
            {
              jsonrpc: '2.0',
              id: (cleartextMessage(request) as { id: number }).id,
              error: {
                code: PAYMENT_REQUIRED_ERROR_CODE,
                message: 'Payment Required',
                data: { payment_options: new Array(1000).fill(option) },
              },
            },
            [
              ['p', client.pubkey],
              ['e', request.id],
            ],
          ),
        );
        await expect(pending).rejects.toThrow('Invalid payment message');
        expect(scenario.probe.counts()).toMatchObject({
          approved: 0,
          submitted: 0,
        });
      },
    ));

  test('[F12] concurrent clients with identical invocations and JSON-RPC ids stay isolated', () =>
    withScenario(new PaidScenario(), async (scenario) => {
      const first = await scenario.start();
      const second = await scenario.addClient('client-b');
      const results = await Promise.all([first.call(11), second.call(11)]);
      for (const result of results)
        expect(result.content).toEqual([{ type: 'text', text: '11' }]);
      expect(scenario.probe.counts()).toMatchObject({
        prepared: 2,
        submitted: 2,
        consumed: 2,
        dispatched: 2,
      });
    }));

  test('[F15] closing the client during payment prevents wallet work and server dispatch', () =>
    withScenario(new PaidScenario({ ttl: 1 }), async (scenario) => {
      const client = await scenario.start();
      const offer = scenario.hub.fault('hold', {
        from: 'server',
        to: 'client',
        match: isMethod(PAYMENT_REQUIRED_METHOD),
      });
      const pending = client.call(12, 5000).catch((error: unknown) => error);
      await offer.hit();
      await client.client.close();
      offer.release();
      expect(await pending).toBeInstanceOf(Error);
      // Verification is bounded by the offer TTL; nothing settles or dispatches.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(scenario.probe.counts()).toMatchObject({
        prepared: 1,
        submitted: 0,
        settled: 0,
        dispatched: 0,
      });
    }));
});
