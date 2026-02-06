import type { NostrServerTransport } from '../transport/nostr-server-transport.js';
import type { PaymentProcessor, PricedCapability } from './types.js';
import { createCapTagsFromPricedCapabilities } from './cap-tags.js';
import { createPmiTagsFromProcessors } from './pmi-tags.js';
import { createServerPaymentsMiddleware } from './server-payments.js';

export interface ServerTransportPaymentsOptions {
  processors: readonly PaymentProcessor[];
  pricedCapabilities: readonly PricedCapability[];
  /**
   * Maximum time to keep a request in pending-payment state.
   * @default 60_000
   */
  paymentTtlMs?: number;
}

/**
 * Attaches CEP-8 payments gating to a NostrServerTransport.
 */
export function withServerPayments(
  transport: NostrServerTransport,
  options: ServerTransportPaymentsOptions,
): NostrServerTransport {
  // CEP-8 discovery tags: advertise supported PMIs + reference pricing on announcement/list events.
  transport.setAnnouncementExtraTags(createPmiTagsFromProcessors(options.processors));
  transport.setAnnouncementPricingTags(
    createCapTagsFromPricedCapabilities(options.pricedCapabilities),
  );

  transport.addInboundMiddleware(
    createServerPaymentsMiddleware({ sender: transport, options }),
  );
  return transport;
}
