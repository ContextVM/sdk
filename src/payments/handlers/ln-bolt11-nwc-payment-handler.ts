import type { RelayHandler } from '../../core/interfaces.js';
import type { PaymentHandler, PaymentHandlerRequest } from '../types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';
import { parseNwcConnectionString } from '../nip47/connection.js';
import { NwcClient } from '../nip47/nwc-client.js';
import { ApplesauceRelayPool } from '../../relay/applesauce-relay-pool.js';

export interface LnBolt11NwcPaymentHandlerOptions {
  /** NIP-47 `nostr+walletconnect://...` connection string. */
  nwcConnectionString: string;
  /** Optional relay handler to reuse; defaults to an ApplesauceRelayPool built from the connection relays. */
  relayHandler?: RelayHandler;
  /** Per-payment response timeout. @default 60_000 */
  responseTimeoutMs?: number;
}

/**
 * CEP-8 client payment handler for PMI `bitcoin-lightning-bolt11` backed by NIP-47 (NWC).
 */
export class LnBolt11NwcPaymentHandler implements PaymentHandler {
  public readonly pmi = PMI_BITCOIN_LIGHTNING_BOLT11;

  private readonly nwc: NwcClient;

  public constructor(options: LnBolt11NwcPaymentHandlerOptions) {
    const connection = parseNwcConnectionString(options.nwcConnectionString);
    const relayHandler =
      options.relayHandler ?? new ApplesauceRelayPool([...connection.relays]);

    this.nwc = new NwcClient({
      relayHandler,
      connection,
      responseTimeoutMs: options.responseTimeoutMs,
    });
  }

  public async handle(req: PaymentHandlerRequest): Promise<void> {
    const response = await this.nwc.request({
      method: 'pay_invoice',
      resultType: 'pay_invoice',
      request: {
        method: 'pay_invoice',
        params: {
          invoice: req.pay_req,
        },
      },
    });

    if (response.error) {
      throw new Error(
        `NWC pay_invoice failed: ${response.error.code} (${response.error.message})`,
      );
    }
  }
}
