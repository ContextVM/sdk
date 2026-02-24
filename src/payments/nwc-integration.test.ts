import { describe, expect, test } from 'bun:test';
import { LnBolt11NwcPaymentHandler } from './handlers/ln-bolt11-nwc-payment-handler.js';
import { LnBolt11NwcPaymentProcessor } from './processors/ln-bolt11-nwc-payment-processor.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from './pmis.js';

const nwcEnabled = process.env.NWC_INTEGRATION === 'true';

describe('nwc integration (skipped by default)', () => {
  test.skipIf(!nwcEnabled)(
    'can make + pay + verify a small invoice via NWC',
    async () => {
      const serverConn = process.env.NWC_SERVER_CONNECTION;
      const clientConn = process.env.NWC_CLIENT_CONNECTION;

      if (!serverConn || !clientConn) {
        throw new Error(
          'Set NWC_SERVER_CONNECTION and NWC_CLIENT_CONNECTION when NWC_INTEGRATION=true',
        );
      }

      const processor = new LnBolt11NwcPaymentProcessor({
        nwcConnectionString: serverConn,
        ttlSeconds: 120,
        pollIntervalMs: 1500,
      });
      const handler = new LnBolt11NwcPaymentHandler({
        nwcConnectionString: clientConn,
      });

      const paymentRequired = await processor.createPaymentRequired({
        amount: 1,
        description: 'ctxvm nwc integration test',
        requestEventId: 'nwc-integration-test',
        clientPubkey: '0'.repeat(64),
      });

      await handler.handle({
        amount: paymentRequired.amount,
        pay_req: paymentRequired.pay_req,
        pmi: PMI_BITCOIN_LIGHTNING_BOLT11,
        description: paymentRequired.description,
        requestEventId: 'nwc-integration-test',
      });

      const verified = await processor.verifyPayment({
        pay_req: paymentRequired.pay_req,
        requestEventId: 'nwc-integration-test',
        clientPubkey: '0'.repeat(64),
      });

      expect(verified._meta).toBeDefined();
    },
    60_000,
  );
});
