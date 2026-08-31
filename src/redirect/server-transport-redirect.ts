import type { NostrServerTransport } from '../transport/nostr-server-transport.js';
import type { ServerRedirectConfig } from './types.js';
import { createRedirectMiddleware } from './server-redirect.js';

/**
 * Attaches CEP-47 server redirection middleware to a NostrServerTransport.
 *
 * When an inbound JSON-RPC request arrives, the middleware evaluates `config.resolveRedirect`.
 * If a target is returned, the server responds with a `-32044 Redirect` error response
 * and halts further processing of the request.
 *
 * @param transport The server transport to wrap.
 * @param config The server redirection configuration.
 * @returns The wrapped server transport with redirection middleware attached.
 */
export function withServerRedirect(
  transport: NostrServerTransport,
  config: ServerRedirectConfig,
): NostrServerTransport {
  transport.addInboundMiddleware(
    createRedirectMiddleware({
      config,
      sendResponse: async (clientPubkey, response, requestEventId) => {
        await transport.sendTargetedResponse(
          clientPubkey,
          response,
          requestEventId,
        );
      },
    }),
  );
  return transport;
}
