import type { NostrServerTransport } from '../transport/nostr-server-transport.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import { createCapTagsFromPricedCapabilities } from './cap-tags.js';
import { createPmiTagsFromProcessors } from './pmi-tags.js';
import { createServerPaymentsMiddleware } from './server-payments.js';

/**
 * Attaches CEP-8 payments gating to a NostrServerTransport.
 */
export function withServerPayments(
  transport: NostrServerTransport,
  options: ServerPaymentsOptions,
): NostrServerTransport {
  // CEP-8 discovery tags: advertise supported PMIs + reference pricing on announcement/list events.
  transport.setAnnouncementExtraTags(
    createPmiTagsFromProcessors(options.processors),
  );
  transport.setAnnouncementPricingTags(
    createCapTagsFromPricedCapabilities(options.pricedCapabilities),
  );

  transport.addInboundMiddleware(
    createServerPaymentsMiddleware({ sender: transport, options }),
  );
  return transport;
}
