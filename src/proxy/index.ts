import { Transport } from '@contextvm/mcp-sdk/shared/transport.js';
import { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';
import {
  NostrClientTransport,
  NostrTransportOptions,
} from '../transport/nostr-client-transport.js';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('proxy');

/**
 * Options for configuring the NostrMCPProxy.
 */
export interface NostrMCPProxyOptions {
  /**
   * The transport for the local MCP Host (e.g., StdioServerTransport).
   */
  mcpHostTransport: Transport;
  /**
   * Configuration options for the client-facing Nostr transport.
   */
  nostrTransportOptions: NostrTransportOptions;
}

/**
 * `NostrMCPProxy` acts as a bridge between a local MCP Host
 * and a remote MCP Server accessible via the Nostr network.
 *
 * It listens for MCP messages from the local host, forwards them over Nostr,
 * and relays the responses back.
 */
export class NostrMCPProxy {
  private mcpHostTransport: Transport;
  private nostrTransport: NostrClientTransport;

  constructor(options: NostrMCPProxyOptions) {
    this.mcpHostTransport = options.mcpHostTransport;
    this.nostrTransport = new NostrClientTransport(
      options.nostrTransportOptions,
    );
  }

  /**
   * Starts the proxy, establishing connections to both the local MCP host
   * and the remote Nostr transport.
   *
   * @returns Promise that resolves when both transports are started
   */
  public async start(): Promise<void> {
    // Set up message handlers
    this.setupEventHandlers();
    // Start both transports
    await Promise.all([
      this.mcpHostTransport.start(),
      this.nostrTransport.start(),
    ]);

    logger.info('NostrMCPProxy started.');
  }

  /**
   * Stops the proxy and closes all connections.
   *
   * @returns Promise that resolves when both transports are closed
   */
  public async stop(): Promise<void> {
    await this.mcpHostTransport.close();
    await this.nostrTransport.close();
    logger.info('NostrMCPProxy stopped.');
  }

  private setupEventHandlers(): void {
    // Forward messages from the local host to Nostr.
    this.mcpHostTransport.onmessage = (message: JSONRPCMessage) => {
      this.nostrTransport
        .send(message)
        .catch((err) => logger.error('Error sending message to Nostr:', err));
    };
    this.mcpHostTransport.onerror = (err) =>
      logger.error('MCP Host Transport Error:', err);
    this.mcpHostTransport.onclose = () =>
      logger.info('MCP Host Transport closed');

    // Forward messages from Nostr back to the local host.
    this.nostrTransport.onmessage = (message: JSONRPCMessage) => {
      this.mcpHostTransport
        .send(message)
        .catch((err) =>
          logger.error('Error sending message to local host:', err),
        );
    };
    this.nostrTransport.onerror = (err) =>
      logger.error('Nostr Transport Error:', err);
    this.nostrTransport.onclose = () => logger.info('Nostr Transport closed');
  }
}
