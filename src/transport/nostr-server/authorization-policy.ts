/**
 * Internal authorization policy for NostrServerTransport.
 * Handles whitelist and excluded-capability checks.
 *
 * This module is not exported from the public API.
 */

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
  /** List of capabilities that are excluded from public key whitelisting requirements */
  excludedCapabilities?: CapabilityExclusion[];
  /** Whether this is a public server (affects unauthorized response behavior) */
  isPublicServer?: boolean;
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
  private readonly excludedCapabilities?: CapabilityExclusion[];
  public readonly isPublicServer?: boolean;

  constructor(options: AuthorizationPolicyOptions = {}) {
    this.allowedPublicKeys = options.allowedPublicKeys;
    this.excludedCapabilities = options.excludedCapabilities;
    this.isPublicServer = options.isPublicServer;
  }

  /**
   * Checks if a capability is excluded from whitelisting requirements.
   * @param method The JSON-RPC method (e.g., 'tools/call', 'tools/list')
   * @param name Optional capability name for method-specific exclusions (e.g., 'get_weather')
   * @returns true if the capability should bypass whitelisting, false otherwise
   */
  private isCapabilityExcluded(method: string, name?: string): boolean {
    // Always allow fundamental MCP methods for connection establishment
    if (method === 'initialize' || method === 'notifications/initialized') {
      return true;
    }

    if (!this.excludedCapabilities?.length) {
      return false;
    }

    return this.excludedCapabilities.some((exclusion) => {
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
    });
  }

  /**
   * Determines whether a message should be allowed based on authorization policy.
   *
   * @param clientPubkey The client's public key
   * @param message The incoming JSON-RPC message
   * @returns Authorization decision indicating whether the message is allowed
   */
  authorize(
    clientPubkey: string,
    message: JSONRPCMessage,
  ): AuthorizationDecision {
    // If no whitelist is configured, allow all messages
    if (!this.allowedPublicKeys?.size) {
      return { allowed: true };
    }

    // Check if the message should bypass whitelisting due to excluded capabilities
    const shouldBypassWhitelisting =
      this.excludedCapabilities?.length &&
      (isJSONRPCRequest(message) || isJSONRPCNotification(message)) &&
      this.isCapabilityExcluded(
        message.method,
        message.params?.name as string | undefined,
      );

    if (this.allowedPublicKeys.has(clientPubkey) || shouldBypassWhitelisting) {
      return { allowed: true };
    }

    // Message is not authorized
    // Only send unauthorized response for requests on public servers
    const shouldReplyUnauthorized: boolean =
      (this.isPublicServer ?? false) && isJSONRPCRequest(message);

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
