import type { RelayHandler } from '../../core/interfaces.js';
import type { PaymentHandler, PaymentHandlerRequest } from '../types.js';
import { PMI_BITCOIN_LIGHTNING_BOLT11 } from '../pmis.js';
import { parseNwcConnectionString } from '../nip47/connection.js';
import { NwcClient } from '../nip47/nwc-client.js';
import { ApplesauceRelayPool } from '../../relay/applesauce-relay-pool.js';
import { assertBolt11Amount, type Bolt11Network } from '../bolt11.js';

export interface LnBolt11NwcPaymentHandlerOptions {
  /** NIP-47 `nostr+walletconnect://...` connection string. */
  nwcConnectionString: string;
  /** Optional relay handler to reuse; defaults to an ApplesauceRelayPool built from the connection relays. */
  relayHandler?: RelayHandler;
  /** Per-payment response timeout. @default 60_000 */
  responseTimeoutMs?: number;
  /** Refuse invoices for any other network before wallet submission. */
  network?: Bolt11Network;
}

/**
 * CEP-8 client payment handler for PMI `bitcoin-lightning-bolt11` backed by NIP-47 (NWC).
 */
export class LnBolt11NwcPaymentHandler implements PaymentHandler {
  public readonly pmi = PMI_BITCOIN_LIGHTNING_BOLT11;

  private readonly nwc: NwcClient;
  private readonly network?: Bolt11Network;

  public constructor(options: LnBolt11NwcPaymentHandlerOptions) {
    this.network = options.network;
    const connection = parseNwcConnectionString(options.nwcConnectionString);
    const relayHandler =
      options.relayHandler ?? new ApplesauceRelayPool([...connection.relays]);

    this.nwc = new NwcClient({
      relayHandler,
      ownsRelayHandler: !options.relayHandler,
      connection,
      responseTimeoutMs: options.responseTimeoutMs,
    });
  }

  /** Stops owned NWC work without disconnecting a shared caller pool. */
  public async dispose(): Promise<void> {
    await this.nwc.disconnect();
  }

  /** Declines, before any wallet action, invoices that do not encode the offered amount. */
  public canHandle(req: PaymentHandlerRequest): boolean {
    try {
      this.assertPayable(req);
      return true;
    } catch {
      return false;
    }
  }

  public async handle(req: PaymentHandlerRequest): Promise<void> {
    this.assertPayable(req);
    const response = await this.nwc.request({
      method: 'pay_invoice',
      abortSignal: req.abortSignal,
      deadlineMs: req.deadlineMs,
      resultType: 'pay_invoice',
      request: {
        method: 'pay_invoice',
        params: {
          invoice: req.pay_req,
        },
      },
    });

    if (response.error) {
      throw new Error(`NWC pay_invoice failed: ${response.error.code}`);
    }
  }

  private assertPayable(req: PaymentHandlerRequest): void {
    assertBolt11Amount(req.pay_req, {
      amountSats: req.amount,
      network: this.network,
    });
  }
}
