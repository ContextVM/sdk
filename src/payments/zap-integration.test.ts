import { describe, expect, test } from 'bun:test';
import { LnBolt11NwcPaymentHandler } from './handlers/ln-bolt11-nwc-payment-handler.js';
import { LnBolt11ZapPaymentProcessor } from './processors/ln-bolt11-zap-payment-processor.js';

const zapEnabled = process.env.ZAP_INTEGRATION === 'true';

describe('zap integration (skipped by default)', () => {
  test.skipIf(!zapEnabled)(
    'can make + pay + verify a small invoice via NIP-57 receipts',
    async () => {
      const clientConn = process.env.NWC_CLIENT_CONNECTION;
      const lnAddress = process.env.ZAP_LN_ADDRESS || 'contextvm@coinos.io';

      if (!clientConn || !lnAddress) {
        throw new Error(
          'Set NWC_CLIENT_CONNECTION and ZAP_LN_ADDRESS when ZAP_INTEGRATION=true',
        );
      }

      const processor = new LnBolt11ZapPaymentProcessor({
        lnAddress,
        relayUrls: process.env.ZAP_RELAY_URLS
          ? process.env.ZAP_RELAY_URLS.split(',').map((s) => s.trim())
          : undefined,
      });
      const handler = new LnBolt11NwcPaymentHandler({
        nwcConnectionString: clientConn,
      });

      const paymentRequired = await processor.createPaymentRequired({
        amount: 1,
        requestEventId: 'zap-integration-test',
        clientPubkey: '0'.repeat(64),
      });

      await handler.handle({
        amount: paymentRequired.amount,
        pay_req: paymentRequired.pay_req,
        requestEventId: 'zap-integration-test',
      });

      const verified = await processor.verifyPayment({
        pay_req: paymentRequired.pay_req,
        requestEventId: 'zap-integration-test',
        clientPubkey: '0'.repeat(64),
      });

      expect(verified._meta).toBeDefined();
    },
    180_000,
  );
});
