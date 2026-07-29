import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@contextvm/mcp-sdk/types.js';

import { NostrClientTransport } from '../transport/nostr-client-transport.js';
import { REDIRECT_ERROR_CODE } from '../payments/constants.js';
import { LruCache } from '../core/utils/lru-cache.js';
import { createLogger } from '../core/utils/logger.js';
import type {
  ClientRedirectOptions,
  RedirectErrorData,
  RedirectTransportConfig,
} from './types.js';

type TransportWithContext = Transport & {
  onmessageWithContext?: (
    message: JSONRPCMessage,
    ctx: { eventId: string; correlatedEventId?: string },
  ) => void;
  serverPubkey?: string;
};

function supportsOnmessageWithContext(
  transport: Transport,
): transport is TransportWithContext {
  return Object.prototype.hasOwnProperty.call(
    transport,
    'onmessageWithContext',
  );
}

function isRedirectError(
  msg: JSONRPCMessage,
): msg is JSONRPCErrorResponse {
  return (
    isJSONRPCErrorResponse(msg) &&
    msg.error.code === REDIRECT_ERROR_CODE &&
    msg.error.data != null &&
    typeof (msg.error.data as Record<string, unknown>).target === 'string'
  );
}

/**
 * Wraps a client transport to automatically handle CEP-47 Server Redirect (-32044) responses.
 *
 * When the server returns `-32044 Redirect`, the wrapper:
 * 1. Validates the target 64-character lowercase hex pubkey.
 * 2. Checks hop limits against `maxRedirects` (default 5, scoped per original request ID).
 * 3. Evaluates optional `redirectPolicy` hook.
 * 4. Transparently creates a new NostrClientTransport to the redirected target and relays.
 * 5. Re-applies optional decorators via `wrapTransport` (e.g., `withClientPayments`).
 * 6. Swaps the active transport session and re-issues the original request.
 * 7. Cleanly terminates the old transport session (abandoning pending payment/stream states).
 *
 * @param transport The base client transport to wrap.
 * @param transportConfig Configuration for spawning new target transports upon redirect.
 * @param options Client redirect handling rules and observability hooks.
 * @returns A wrapped transport that handles redirection transparently.
 */
export function withClientRedirect(
  transport: Transport,
  transportConfig: RedirectTransportConfig,
  options?: ClientRedirectOptions,
): Transport {
  const logger = createLogger('client-redirect');
  const maxRedirects = options?.maxRedirects ?? 5;
  const rawRequestCache = new LruCache<JSONRPCRequest>(1000);
  const redirectCounts = new Map<string | number, number>();

  let currentTransport = transport;
  let currentServerPubkey: string | undefined =
    transport instanceof NostrClientTransport
      ? transport.serverPubkey
      : (transport as unknown as { serverPubkey?: string }).serverPubkey;
  let activeTransitionPromise: Promise<void> | null = null;

  let onmessage: ((message: JSONRPCMessage) => void) | undefined;
  let onmessageWithContext:
    | ((
        message: JSONRPCMessage,
        ctx: { eventId: string; correlatedEventId?: string },
      ) => void)
    | undefined;
  let onerror: ((error: Error) => void) | undefined;
  let onclose: (() => void) | undefined;

  const synthesizeError = (
    id: string | number | undefined,
    code: number,
    message: string,
    data?: unknown,
  ): void => {
    const errObj: JSONRPCMessage = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    } as unknown as JSONRPCMessage;
    if (onmessageWithContext) {
      onmessageWithContext(errObj, { eventId: 'synthetic' });
    } else {
      onmessage?.(errObj);
    }
  };

  const forwardMessage = (
    message: JSONRPCMessage,
    ctx?: { eventId: string; correlatedEventId?: string },
  ): void => {
    if (ctx && onmessageWithContext) {
      onmessageWithContext(message, ctx);
    } else {
      onmessage?.(message);
    }
  };

  const bindTransportHandlers = (targetTransport: Transport): void => {
    const hasContextPath = supportsOnmessageWithContext(targetTransport);

    targetTransport.onmessage = (message: JSONRPCMessage) => {
      if (hasContextPath && isJSONRPCNotification(message)) {
        return;
      }
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        if ('id' in message && message.id != null && !isRedirectError(message)) {
          const reqId = message.id as string | number;
          rawRequestCache.delete(String(reqId));
          redirectCounts.delete(reqId);
        }
      }
      if (hasContextPath) {
        return;
      }
      void handleInbound(message, undefined);
    };

    if (hasContextPath) {
      targetTransport.onmessageWithContext = (message, ctx) => {
        void handleInbound(message, ctx);
      };
    }

    targetTransport.onerror = (err: Error) => onerror?.(err);
    targetTransport.onclose = () => {
      if (currentTransport === targetTransport) {
        onclose?.();
      }
    };
  };

  const performTransition = async (target: string, relays?: string[]): Promise<void> => {
    if (currentServerPubkey === target) {
      return;
    }
    logger.info('Following server redirect to target', {
      from: currentServerPubkey,
      to: target,
      relays,
    });

    const oldTransport = currentTransport;
    const { wrapTransport, ...baseOpts } = transportConfig;

    const newNostrTransport = new NostrClientTransport({
      ...baseOpts,
      serverPubkey: target,
      relayHandler: relays && relays.length > 0 ? relays : undefined,
    });

    let newTransport: Transport = newNostrTransport;
    if (wrapTransport) {
      newTransport = wrapTransport(newTransport);
    }

    bindTransportHandlers(newTransport);
    console.log('--- STARTING NEW TRANSPORT ---');
    await newTransport.start();
    console.log('--- NEW TRANSPORT STARTED ---');

    currentTransport = newTransport;
    currentServerPubkey = target;

    try {
      await oldTransport.close();
    } catch (err: unknown) {
      logger.warn('Error closing old transport during redirect swap', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleInbound = async (
    message: JSONRPCMessage,
    ctx?: { eventId: string; correlatedEventId?: string },
  ): Promise<void> => {
    if (!isRedirectError(message)) {
      forwardMessage(message, ctx);
      return;
    }

    const errorData = message.error.data as unknown as RedirectErrorData;
    const reqId = message.id as string | number;

    if (!errorData.target || !/^[0-9a-f]{64}$/.test(errorData.target)) {
      logger.error('Invalid redirect target pubkey received', {
        target: errorData.target,
        requestId: reqId,
      });
      forwardMessage(message, ctx);
      return;
    }

    const currentHops = (redirectCounts.get(reqId) ?? 0) + 1;
    if (currentHops > maxRedirects) {
      logger.error('Maximum redirect hops exceeded for request', {
        maxRedirects,
        currentHops,
        requestId: reqId,
      });
      redirectCounts.delete(reqId);
      rawRequestCache.delete(String(reqId));
      forwardMessage(message, ctx);
      return;
    }
    redirectCounts.set(reqId, currentHops);

    if (options?.redirectPolicy) {
      let allowed = false;
      try {
        allowed = await options.redirectPolicy(errorData);
      } catch (err: unknown) {
        logger.error('Error in redirectPolicy hook, rejecting redirect', {
          error: err instanceof Error ? err.message : String(err),
          requestId: reqId,
        });
      }
      if (!allowed) {
        redirectCounts.delete(reqId);
        rawRequestCache.delete(String(reqId));
        forwardMessage(message, ctx);
        return;
      }
    }

    if (!activeTransitionPromise) {
      activeTransitionPromise = performTransition(errorData.target, errorData.relays)
        .finally(() => {
          activeTransitionPromise = null;
        });
    }

    try {
      await activeTransitionPromise;
    } catch (err: unknown) {
      logger.error('Failed to transition to redirect target transport', {
        error: err instanceof Error ? err.message : String(err),
        target: errorData.target,
        requestId: reqId,
      });
      redirectCounts.delete(reqId);
      rawRequestCache.delete(String(reqId));
      forwardMessage(message, ctx);
      return;
    }

    options?.onRedirect?.(errorData, currentHops);

    const origReq = rawRequestCache.get(String(reqId));
    if (!origReq) {
      logger.error('Cannot re-issue redirected request: original request not found in cache', {
        requestId: reqId,
      });
      redirectCounts.delete(reqId);
      forwardMessage(message, ctx);
      return;
    }

    logger.debug('Re-issuing request to redirected target', {
      method: origReq.method,
      requestId: reqId,
      target: errorData.target,
      hop: currentHops,
    });

    try {
      if (activeTransitionPromise) {
        await activeTransitionPromise;
      }
      await currentTransport.send(origReq);
    } catch (err: unknown) {
      logger.error('Error re-issuing request to redirected target', {
        error: err instanceof Error ? err.message : String(err),
        requestId: reqId,
      });
      synthesizeError(
        reqId,
        -32000,
        `Failed to re-issue request after redirect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const wrapped: TransportWithContext = {
    get onmessage() {
      return onmessage;
    },
    set onmessage(fn) {
      onmessage = fn;
    },
    get onmessageWithContext() {
      return onmessageWithContext;
    },
    set onmessageWithContext(fn) {
      onmessageWithContext = fn;
    },
    get onerror() {
      return onerror;
    },
    set onerror(fn) {
      onerror = fn;
    },
    get onclose() {
      return onclose;
    },
    set onclose(fn) {
      onclose = fn;
    },
    get serverPubkey() {
      return currentServerPubkey;
    },

    async start(): Promise<void> {
      bindTransportHandlers(currentTransport);
      await currentTransport.start();
    },

    async send(message: JSONRPCMessage): Promise<void> {
      if (isJSONRPCRequest(message) && 'id' in message && message.id != null) {
        rawRequestCache.set(String(message.id), message as JSONRPCRequest);
      }
      if (activeTransitionPromise) {
        await activeTransitionPromise;
      }
      await currentTransport.send(message);
    },

    async close(): Promise<void> {
      await currentTransport.close();
    },
  };

  return wrapped;
}
