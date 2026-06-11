import type { NostrServerTransport } from '../transport/nostr-server-transport.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import { createCapTagsFromPricedCapabilities } from './cap-tags.js';
import { createPmiTagsFromProcessors } from './pmi-tags.js';
import { createServerPaymentsMiddleware } from './server-payments.js';
import { createExplicitGatingMiddleware } from './server-explicit-gating.js';
import { AuthorizationStore } from './authorization-store.js';

/**
 * Attaches CEP-8 payments gating to a NostrServerTransport.
 */
export function withServerPayments(
  transport: NostrServerTransport,
  options: ServerPaymentsOptions,
): NostrServerTransport {
  // CEP-8 discovery tags: advertise supported PMIs + reference pricing on announcement/list events.
  const extraTags = createPmiTagsFromProcessors(options.processors);
  
  if (options.paymentInteraction === 'explicit_gating') {
    extraTags.push(['payment_interaction', 'explicit_gating'] as any);
  }
  
  transport.setAnnouncementExtraTags(extraTags);
  transport.setAnnouncementPricingTags(
    createCapTagsFromPricedCapabilities(options.pricedCapabilities),
  );

  // Expose the configured payment interaction mode to the transport coordinator.
  transport.setSupportedPaymentInteraction(options.paymentInteraction);

  if (options.paymentInteraction === 'explicit_gating') {
    const authorizationStore = new AuthorizationStore({});
    transport.addInboundMiddleware(
      createExplicitGatingMiddleware({
        options,
        authorizationStore,
        sendResponse: async (clientPubkey, response, requestEventId) => {
          await transport.sendTargetedResponse(clientPubkey, response, requestEventId);
        },
      }),
    );
  } else {
    transport.addInboundMiddleware(
      createServerPaymentsMiddleware({ sender: transport, options }),
    );
  }
  return transport;
}
