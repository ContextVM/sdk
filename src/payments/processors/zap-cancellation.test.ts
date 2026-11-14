import { expect, test } from 'bun:test';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import type { Filter, NostrEvent } from 'nostr-tools';
import type { RelayHandler } from '../../core/interfaces.js';
import { LnBolt11ZapPaymentProcessor } from './ln-bolt11-zap-payment-processor.js';

for (const earlyAbort of [false, true])
  test(`zap verification authenticates receipts and releases only owned subscriptions, abort=${earlyAbort}`, async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    let receive: ((event: NostrEvent) => void) | undefined;
    let unsubscribed = 0;
    let disconnected = 0;
    const relay: RelayHandler = {
      async connect() {},
      async disconnect() {
        disconnected++;
      },
      async publish() {},
      unsubscribe() {
        throw new Error('Must not unsubscribe shared connections');
      },
      getRelayUrls() {
        return ['wss://example.invalid'];
      },
      async subscribe(
        _filters: Filter[],
        callback: (event: NostrEvent) => void,
      ) {
        receive = callback;
        await Bun.sleep(10);
        return () => {
          unsubscribed++;
        };
      },
    };
    const http = async (): Promise<Response> =>
      Response.json({
        callback: 'https://example.invalid/callback',
        nostrPubkey: pubkey,
        allowsNostr: true,
      });
    const processor = new LnBolt11ZapPaymentProcessor({
      lnAddress: 'receiver@example.invalid',
      relayHandler: relay,
      fetch: http,
      ttlSeconds: 1,
    });
    const abort = new AbortController();
    const pending = processor.verifyPayment({
      pay_req: 'invoice',
      clientPubkey: 'client',
      requestEventId: 'request',
      abortSignal: abort.signal,
    });
    const outcome = pending.catch((error) => error);
    while (!receive) await Bun.sleep(1);
    if (earlyAbort) abort.abort();
    else {
      const receipt = finalizeEvent(
        {
          kind: 9735,
          content: '',
          created_at: Math.floor(Date.now() / 1000),
          tags: [['bolt11', 'invoice']],
        },
        secret,
      );
      let finished = false;
      void outcome.then(() => {
        finished = true;
      });
      receive(
        JSON.parse(
          JSON.stringify({ ...receipt, sig: '0'.repeat(128) }),
        ) as NostrEvent,
      );
      await Bun.sleep(1);
      expect(finished).toBe(false);
      receive(receipt);
    }
    const result = await outcome;
    if (earlyAbort) expect(result).toBeInstanceOf(Error);
    else expect(result._meta?.zap_receipt_event_id).toBeDefined();
    await processor.dispose();
    await processor.dispose();
    await Bun.sleep(15);
    expect(unsubscribed).toBe(1);
    expect(disconnected).toBe(0);
  });
