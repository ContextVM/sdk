import {
  INITIALIZE_METHOD,
  NOTIFICATIONS_INITIALIZED_METHOD,
} from '@contextvm/sdk/core/constants.js';
import type {
  JSONRPCMessage,
  InitializeResult,
  JSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

/**
 * Manages stateless mode emulation for public Nostr servers.
 * Provides emulated initialize responses for clients that cannot
 * maintain persistent connections to the server.
 */
export class StatelessModeHandler {
  /**
   * Creates an emulated initialize response for stateless clients.
   * This response mimics what a real server would return during initialization,
   * allowing stateless clients to function without maintaining a connection.
   * @param requestId - The original request ID to include in the response
   * @returns A JSON-RPC result response with emulated server capabilities
   */
  createEmulatedResponse(requestId: string | number): JSONRPCResultResponse {
    const emulatedResult: InitializeResult = {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      serverInfo: {
        name: 'Emulated-Stateless-Server',
        version: '1.0.0',
      },
      capabilities: {
        tools: {
          listChanged: true,
        },
        prompts: {
          listChanged: true,
        },
        resources: {
          subscribe: true,
          listChanged: true,
        },
      },
    };

    return {
      jsonrpc: '2.0',
      id: requestId,
      result: emulatedResult,
    };
  }

  /**
   * Checks if a message should be handled in stateless mode.
   * Stateless mode handles special messages that don't require server interaction.
   * @param message - The JSON-RPC message to check
   * @returns true if the message should be handled statelessly
   */
  shouldHandleStatelessly(message: JSONRPCMessage): boolean {
    if (
      'method' in message &&
      message.method === INITIALIZE_METHOD &&
      'id' in message
    ) {
      return true;
    }
    if (
      'method' in message &&
      message.method === NOTIFICATIONS_INITIALIZED_METHOD
    ) {
      return true;
    }
    return false;
  }
}
