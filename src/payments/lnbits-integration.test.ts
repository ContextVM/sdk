import { describe, expect, test } from 'bun:test';
import { LnBolt11LnbitsPaymentHandler } from './handlers/ln-bolt11-lnbits-payment-handler.js';
import { LnBolt11LnbitsPaymentProcessor } from './processors/ln-bolt11-lnbits-payment-processor.js';

const lnbitsEnabled = process.env.LNBITS_INTEGRATION === 'true';

describe('lnbits integration (skipped by default)', () => {
  test.skipIf(!lnbitsEnabled)(
    'can make + pay + verify a small invoice via LNbits',
    async () => {
      const serverUrl = process.env.LNBITS_SERVER_URL;
      const serverKey = process.env.LNBITS_SERVER_KEY;
      const clientUrl = process.env.LNBITS_CLIENT_URL;
      const clientAdminKey = process.env.LNBITS_CLIENT_ADMIN_KEY;
      const basicAuth = process.env.LNBITS_BASIC_AUTH;

      if (!serverUrl || !serverKey || !clientUrl || !clientAdminKey) {
        throw new Error(
          'Set LNBITS_SERVER_URL, LNBITS_SERVER_KEY, LNBITS_CLIENT_URL, and LNBITS_CLIENT_ADMIN_KEY when LNBITS_INTEGRATION=true',
        );
      }

      const processor = new LnBolt11LnbitsPaymentProcessor({
        lnbitsUrl: serverUrl,
        lnbitsApiKey: serverKey,
        lnbitsBasicAuth: basicAuth,
        ttlSeconds: 120,
        pollIntervalMs: 1500,
      });
      const handler = new LnBolt11LnbitsPaymentHandler({
        lnbitsUrl: clientUrl,
        lnbitsAdminKey: clientAdminKey,
        lnbitsBasicAuth: basicAuth,
      });

      const paymentRequired = await processor.createPaymentRequired({
        amount: 1,
        description: 'ctxvm lnbits integration test',
        requestEventId: 'lnbits-integration-test',
        clientPubkey: '0'.repeat(64),
      });

      await handler.handle({
        amount: paymentRequired.amount,
        pay_req: paymentRequired.pay_req,
        description: paymentRequired.description,
        requestEventId: 'lnbits-integration-test',
      });

      const verified = await processor.verifyPayment({
        pay_req: paymentRequired.pay_req,
        requestEventId: 'lnbits-integration-test',
        clientPubkey: '0'.repeat(64),
      });

      expect(verified._meta).toBeDefined();
    },
    60_000,
  );
});
