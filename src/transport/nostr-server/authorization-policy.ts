/**
 * Internal authorization policy for NostrServerTransport.
 * Handles whitelist and excluded-capability checks.
 *
 * This module is not exported from the public API.
 */
import {
  INITIALIZE_METHOD,
  NOTIFICATIONS_INITIALIZED_METHOD,
} from '../../core/constants.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  isJSONRPCRequest,
  isJSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Represents a capability exclusion pattern that can bypass whitelisting.
 * Can be either a method-only pattern (e.g., 'tools/list') or a method + name pattern (e.g., 'tools/call, get_weather').
 */
export interface CapabilityExclusion {
  /** The JSON-RPC method to exclude from whitelisting (e.g., 'tools/call', 'tools/list') */
  method: string;
  /** Optional capability name to specifically exclude (e.g., 'get_weather') */
  name?: string;
}

/**
 * Authorization decision result.
 */
export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; shouldReplyUnauthorized: boolean };

/**
 * Options for configuring the AuthorizationPolicy.
 */
export interface AuthorizationPolicyOptions {
  /** Set of allowed public keys (whitelist). If undefined, all clients are allowed. */
  allowedPublicKeys?: Set<string>;
  /** Optional callback for dynamic public key authorization. Returns true to allow the pubkey. */
  isPubkeyAllowed?: (clientPubkey: string) => boolean | Promise<boolean>;
  /** List of capabilities that are excluded from public key whitelisting requirements */
  excludedCapabilities?: CapabilityExclusion[];
  /** Optional callback for dynamic capability exclusions. Returns true to bypass pubkey authorization. */
  isCapabilityExcluded?: (
    exclusion: CapabilityExclusion,
  ) => boolean | Promise<boolean>;
  /**
   * @deprecated Use `isAnnouncedServer` instead. `isPublicServer` will be removed in a future version.
   */
  isPublicServer?: boolean;
  /**
   * Whether this server publishes public announcement events on Nostr for relay-based discovery.
   * Also affects whether unauthorized responses are sent to unauthenticated clients.
   */
  isAnnouncedServer?: boolean;
}

/**
 * Internal policy for authorizing incoming messages.
 *
 * This class encapsulates the authorization logic, making it easier to test
 * and maintain. It handles:
 * - Whitelist checking
 * - Excluded capability checking
 * - Determining whether to send an unauthorized response
 */
export class AuthorizationPolicy {
  private readonly allowedPublicKeys?: Set<string>;
  private readonly isPubkeyAllowed?: (
    clientPubkey: string,
  ) => boolean | Promise<boolean>;
  private readonly excludedCapabilities?: CapabilityExclusion[];
  private readonly isCapabilityExcludedCallback?: (
    exclusion: CapabilityExclusion,
  ) => boolean | Promise<boolean>;
  public readonly isPublicServer?: boolean;
  public readonly isAnnouncedServer?: boolean;

  constructor(options: AuthorizationPolicyOptions = {}) {
    this.allowedPublicKeys = options.allowedPublicKeys;
    this.isPubkeyAllowed = options.isPubkeyAllowed;
    this.excludedCapabilities = options.excludedCapabilities;
    this.isCapabilityExcludedCallback = options.isCapabilityExcluded;
    this.isPublicServer = options.isPublicServer;
    // Support both new and deprecated option names
    this.isAnnouncedServer =
      options.isAnnouncedServer ?? options.isPublicServer;
  }

  /**
   * Checks if a capability is excluded from whitelisting requirements.
   * @param method The JSON-RPC method (e.g., 'tools/call', 'tools/list')
   * @param name Optional capability name for method-specific exclusions (e.g., 'get_weather')
   * @returns true if the capability should bypass whitelisting, false otherwise
   */
  private async isCapabilityExcluded(
    method: string,
    name?: string,
  ): Promise<boolean> {
    // Always allow fundamental MCP methods for connection establishment
    if (
      method === INITIALIZE_METHOD ||
      method === NOTIFICATIONS_INITIALIZED_METHOD
    ) {
      return true;
    }

    const hasStaticExclusions = Boolean(this.excludedCapabilities?.length);
    const staticExclusionMatched =
      this.excludedCapabilities?.some((exclusion) => {
        // Check if method matches
        if (exclusion.method !== method) {
          return false;
        }

        // If exclusion has no name requirement, method match is sufficient
        if (!exclusion.name) {
          return true;
        }

        // If exclusion has a name requirement, check if it matches the provided name
        return exclusion.name === name;
      }) ?? false;

    if (staticExclusionMatched) {
      return true;
    }

    if (!this.isCapabilityExcludedCallback) {
      return hasStaticExclusions ? false : false;
    }

    return this.isCapabilityExcludedCallback({ method, name });
  }

  /**
   * Determines whether a message should be allowed based on authorization policy.
   *
   * @param clientPubkey The client's public key
   * @param message The incoming JSON-RPC message
   * @returns Authorization decision indicating whether the message is allowed
   */
  async authorize(
    clientPubkey: string,
    message: JSONRPCMessage,
  ): Promise<AuthorizationDecision> {
    const hasStaticAllowlist = Boolean(this.allowedPublicKeys?.size);
    const hasDynamicPubkeyCheck = Boolean(this.isPubkeyAllowed);
    const hasCapabilityExclusionRules =
      Boolean(this.excludedCapabilities?.length) ||
      Boolean(this.isCapabilityExcludedCallback);

    // Check if the message should bypass whitelisting due to excluded capabilities
    const shouldBypassWhitelisting =
      hasCapabilityExclusionRules &&
      (isJSONRPCRequest(message) || isJSONRPCNotification(message)) &&
      (await this.isCapabilityExcluded(
        message.method,
        message.params?.name as string | undefined,
      ));

    if (shouldBypassWhitelisting) {
      return { allowed: true };
    }

    // If no pubkey authorization is configured, allow all non-excluded messages
    if (!hasStaticAllowlist && !hasDynamicPubkeyCheck) {
      return { allowed: true };
    }

    const isAllowedByStaticAllowlist =
      !hasStaticAllowlist || this.allowedPublicKeys?.has(clientPubkey) === true;
    const isAllowedByDynamicCheck =
      !this.isPubkeyAllowed || (await this.isPubkeyAllowed(clientPubkey));

    if (isAllowedByStaticAllowlist && isAllowedByDynamicCheck) {
      return { allowed: true };
    }

    // Message is not authorized
    // Only send unauthorized response for requests on announced servers
    const shouldReplyUnauthorized: boolean =
      (this.isAnnouncedServer ?? false) && isJSONRPCRequest(message);

    return { allowed: false, shouldReplyUnauthorized };
  }

  /**
   * Checks if a client public key is in the allowed whitelist.
   * @param clientPubkey The client's public key
   * @returns true if the client is whitelisted, false otherwise
   */
  isClientWhitelisted(clientPubkey: string): boolean {
    if (!this.allowedPublicKeys?.size) {
      return true; // No whitelist means all clients are allowed
    }
    return this.allowedPublicKeys.has(clientPubkey);
  }
}
