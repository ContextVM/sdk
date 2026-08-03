import {
  isJSONRPCRequest,
  type JSONRPCErrorResponse,
} from '@contextvm/mcp-sdk/types.js';

import type { InboundMiddlewareFn } from '../transport/middleware.js';
import type { ServerRedirectConfig } from './types.js';
import { REDIRECT_ERROR_CODE } from '../payments/constants.js';
import { createLogger } from '../core/utils/logger.js';

/**
 * Parameters for creating the server-side redirect middleware.
 */
export interface RedirectMiddlewareParams {
  /** Server redirect configuration including the resolveRedirect callback. */
  config: ServerRedirectConfig;
  /**
   * Callback to emit a targeted JSON-RPC error response back to a client.
   */
  sendResponse: (
    clientPubkey: string,
    response: JSONRPCErrorResponse,
    requestEventId: string,
  ) => Promise<void>;
}

/**
 * Creates an inbound server middleware that evaluates requests for CEP-47 redirection.
 *
 * If `config.resolveRedirect` returns a target, emits a `-32044 Redirect` JSON-RPC error
 * response and short-circuits the middleware pipeline so the request is not processed further.
 * If `resolveRedirect` returns `null` or throws an error (fail-open), forwards the request normally.
 */
export function createRedirectMiddleware(
  params: RedirectMiddlewareParams,
): InboundMiddlewareFn {
  const { config, sendResponse } = params;
  const logger = createLogger('server-redirect');

  return async (message, ctx, forward) => {
    // TODO: CEP-41 streams integration: MUST NOT emit redirect if request has active CEP-41 open stream.
    // Only redirect JSON-RPC requests. Notifications and responses pass through.
    if (!isJSONRPCRequest(message) || message.id == null) {
      await forward(message);
      return;
    }

    const requestEventId = ctx.requestEventId ?? String(message.id);
    let result;
    try {
      result = await config.resolveRedirect({
        clientPubkey: ctx.clientPubkey,
        method: message.method,
        params: message.params as Record<string, unknown> | undefined,
        requestEventId,
      });
    } catch (err: unknown) {
      logger.error(
        'Error in resolveRedirect callback, forwarding request normally (fail-open)',
        {
          error: err instanceof Error ? err.message : String(err),
          clientPubkey: ctx.clientPubkey,
          method: message.method,
          requestEventId,
        },
      );
      await forward(message);
      return;
    }

    // null = do not redirect, forward normally to next middleware / handler
    if (!result) {
      await forward(message);
      return;
    }

    logger.debug('Redirecting client request', {
      clientPubkey: ctx.clientPubkey,
      method: message.method,
      requestEventId,
      target: result.target,
    });

    // Build -32044 error data payload
    const errorData: Record<string, unknown> = { target: result.target };
    if (result.relays && result.relays.length > 0) {
      errorData.relays = result.relays;
    }
    const instructions = result.instructions ?? config.instructions;
    if (instructions) {
      errorData.instructions = instructions;
    }
    const meta = {
      ...(config._meta ?? {}),
      ...(result._meta ?? {}),
    };
    if (Object.keys(meta).length > 0) {
      errorData._meta = meta;
    }

    const errorResponse: JSONRPCErrorResponse = {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: REDIRECT_ERROR_CODE,
        message: 'Redirect',
        data: errorData,
      },
    };

    await sendResponse(ctx.clientPubkey, errorResponse, requestEventId);

    // Do NOT call forward() — request handling is complete.
  };
}
