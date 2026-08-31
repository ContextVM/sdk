import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import type { NostrTransportOptions } from '../transport/index.js';

/**
 * Shape of `error.data` for JSON-RPC -32044 Redirect responses (CEP-47).
 */
export interface RedirectErrorData {
  /** The 64-character lowercase hex public key of the target server. */
  target: string;
  /** Optional relay hints where the target server is reachable. */
  relays?: string[];
  /** Human-readable instructions explaining the redirection. */
  instructions?: string;
  /** Arbitrary metadata attached by the redirecting server. */
  _meta?: Record<string, unknown>;
}

/**
 * Return structure from a `ResolveRedirectFn` callback.
 */
export interface RedirectTarget {
  /** The 64-character lowercase hex public key of the target server. */
  target: string;
  /** Optional relay hints where the target server is reachable. */
  relays?: string[];
  /** Overrides default server instructions when provided. */
  instructions?: string;
  /** Overrides or merges with default server _meta when provided. */
  _meta?: Record<string, unknown>;
}

/**
 * Context passed to `ResolveRedirectFn` when evaluating an inbound request.
 */
export interface RedirectContext {
  /** The public key of the client issuing the request. */
  clientPubkey: string;
  /** The JSON-RPC method being requested (e.g., 'tools/call'). */
  method: string;
  /** The parameters accompanying the JSON-RPC request. */
  params?: Record<string, unknown>;
  /** The Nostr event ID corresponding to the inbound request message. */
  requestEventId: string;
}

/**
 * Server-side callback that resolves whether to redirect an inbound request.
 *
 * Follows the same pattern as `ResolvePriceFn` in CEP-8 payments:
 * receives request context and returns a routing decision.
 *
 * Return `null` to forward the request normally without redirecting.
 * Return a `RedirectTarget` to emit a -32044 error response.
 */
export type ResolveRedirectFn = (
  ctx: RedirectContext,
) => RedirectTarget | null | Promise<RedirectTarget | null>;

/**
 * Server-side redirect middleware configuration.
 */
export interface ServerRedirectConfig {
  /** Callback invoked per request to determine redirection targets. */
  resolveRedirect: ResolveRedirectFn;
  /** Default instructions included in every redirect response unless overridden. */
  instructions?: string;
  /** Default metadata included in every redirect response unless overridden. */
  _meta?: Record<string, unknown>;
}

/**
 * Base transport options used when constructing a redirected NostrClientTransport.
 * Excludes target-specific fields which are supplied dynamically by the redirect error data.
 */
export type BaseRedirectTransportOptions = Omit<
  NostrTransportOptions,
  | 'serverPubkey'
  | 'relayHandler'
  | 'discoveryRelayUrls'
  | 'fallbackOperationalRelayUrls'
>;

/**
 * Configuration for constructing new client transports when following a redirect.
 */
export interface RedirectTransportConfig extends BaseRedirectTransportOptions {
  /**
   * Optional callback to wrap the newly constructed target transport with middleware
   * (e.g., re-applying `withClientPayments` or other decorators).
   */
  wrapTransport?: (transport: Transport) => Transport;
}

/**
 * Client-side options for CEP-47 redirect handling.
 */
export interface ClientRedirectOptions {
  /**
   * Maximum number of consecutive redirects allowed per original request ID.
   * @default 5
   */
  maxRedirects?: number;
  /**
   * Policy hook evaluated before following a redirect.
   * Return `false` to reject the redirection and surface the -32044 error to the caller.
   */
  redirectPolicy?: (data: RedirectErrorData) => boolean | Promise<boolean>;
  /**
   * Observability hook invoked whenever a redirect is successfully followed.
   *
   * @param data The redirect target and metadata received from the server.
   * @param hopNumber The 1-indexed hop count for this request chain.
   */
  onRedirect?: (data: RedirectErrorData, hopNumber: number) => void;
}
