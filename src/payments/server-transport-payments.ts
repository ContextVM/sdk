import type { NostrServerTransport } from '../transport/nostr-server-transport.js';
import type { PaymentInteractionPolicy } from './types.js';
import type { ServerPaymentsOptions } from './server-payments.js';
import { createCapTagsFromPricedCapabilities } from './cap-tags.js';
import { createPmiTagsFromProcessors } from './pmi-tags.js';
import { createServerPaymentsMiddleware } from './server-payments.js';
import { createExplicitGatingMiddleware } from './server-explicit-gating.js';
import { AuthorizationStore } from './authorization-store.js';
import { buildProcessorsByPmi } from './server-payments-utils.js';
import { createLogger } from '../core/utils/logger.js';
import { NOSTR_TAGS } from '../core/constants.js';

/**
 * Attaches CEP-8 payments gating to a NostrServerTransport.
 *
 * By default the server uses the `optional` policy: it advertises
 * `explicit_gating` support and mirrors each client's requested lifecycle, so a
 * client that requests `explicit_gating` is gated while transparent clients keep
 * the notification-based flow. Pass `paymentInteraction: 'transparent'` for a
 * transparent-only server.
 */
export function withServerPayments(
  transport: NostrServerTransport,
  options: ServerPaymentsOptions,
): NostrServerTransport {
  // Build the PMI → processor map once and share it across both middlewares.
  const processorsByPmi = buildProcessorsByPmi(
    options.processors,
    createLogger('server-payments'),
  );

  const policy: PaymentInteractionPolicy =
    options.paymentInteraction ?? 'optional';
  const supportsExplicitGating = policy === 'optional';

  // CEP-8 discovery tags: advertise supported PMIs + reference pricing on
  // announcement/list events. When explicit gating is supported, also advertise
  // it as an available opt-in mode (availability, not effective session mode).
  const extraTags: string[][] = createPmiTagsFromProcessors(options.processors);

  if (supportsExplicitGating) {
    extraTags.push([NOSTR_TAGS.PAYMENT_INTERACTION, 'explicit_gating']);
  }

  transport.setAnnouncementExtraTags(extraTags);
  transport.setAnnouncementPricingTags(
    createCapTagsFromPricedCapabilities(options.pricedCapabilities),
  );

  // Expose the configured policy to the transport coordinator so it can accept
  // or reject per-session `payment_interaction` requests.
  transport.setSupportedPaymentInteraction(policy);

  transport.addInboundMiddleware(
    createServerPaymentsMiddleware({
      sender: transport,
      options,
      processorsByPmi,
    }),
  );

  // The transparent middleware self-gates on the per-session effective mode, so
  // it is safe to register the explicit-gating middleware alongside it. Each
  // request is routed to exactly one lifecycle based on the negotiated mode.
  if (supportsExplicitGating) {
    const authorizationStore = new AuthorizationStore({});
    transport.addInboundMiddleware(
      createExplicitGatingMiddleware({
        options,
        authorizationStore,
        sendResponse: async (clientPubkey, response, requestEventId) => {
          await transport.sendTargetedResponse(
            clientPubkey,
            response,
            requestEventId,
          );
        },
        processorsByPmi,
      }),
    );
  }
  return transport;
}
