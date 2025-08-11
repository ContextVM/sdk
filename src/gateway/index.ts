import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  NostrServerTransport,
  NostrServerTransportOptions,
} from '../transport/nostr-server-transport.js';
import { createLogger } from '../core/utils/logger.js';

const logger = createLogger('gateway');

/**
 * Options for configuring the NostrMCPGateway.
 */
export interface NostrMCPGatewayOptions {
  /** The MCP client transport (e.g., StdioClientTransport) to connect to the original MCP server */
  mcpClientTransport: Transport;
  /** Options for configuring the Nostr server transport */
  nostrTransportOptions: NostrServerTransportOptions;
}

/**
 * The main gateway class that orchestrates communication between Nostr clients
 * and a local MCP server. It acts as a bridge, receiving MCP requests via Nostr
 * events and forwarding them to the local MCP server, then publishing the
 * responses back to Nostr. All request/response correlation is handled by the
 * NostrServerTransport, making this a simple message forwarder.
 * @param options - Configuration options for the gateway
 * @param options.mcpClientTransport - The MCP client transport (e.g., StdioServerTransport)
 *   used to connect to and communicate with the original MCP server
 * @param options.nostrTransportOptions - Configuration options for the Nostr server transport
 */
export class NostrMCPGateway {
  private readonly mcpClientTransport: Transport;
  private readonly nostrServerTransport: NostrServerTransport;
  private isRunning = false;

  constructor(options: NostrMCPGatewayOptions) {
    this.mcpClientTransport = options.mcpClientTransport;
    this.nostrServerTransport = new NostrServerTransport(
      options.nostrTransportOptions,
    );

    this.setupEventHandlers();
  }

  /**
   * Sets up event handlers for both transports.
   */
  private setupEventHandlers(): void {
    // Forward messages from Nostr to the MCP server, handling any potential errors.
    this.nostrServerTransport.onmessage = (message: JSONRPCMessage) => {
      logger.debug('Received message from Nostr:', message);
      this.mcpClientTransport
        .send(message)
        .catch(this.handleServerError.bind(this));
    };
    this.nostrServerTransport.onerror = this.handleNostrError.bind(this);
    this.nostrServerTransport.onclose = this.handleNostrClose.bind(this);

    // Forward messages from the MCP server to the Nostr transport, handling any potential errors.
    this.mcpClientTransport.onmessage = (message: JSONRPCMessage) => {
      logger.debug('Received message from MCP server:', message);
      this.nostrServerTransport
        .send(message)
        .catch(this.handleNostrError.bind(this));
    };
    this.mcpClientTransport.onerror = this.handleServerError.bind(this);
    this.mcpClientTransport.onclose = this.handleServerClose.bind(this);
  }

  /**
   * Starts the gateway, initializing both transports.
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Gateway is already running');
    }

    try {
      // Start both transports
      await this.mcpClientTransport.start();
      await this.nostrServerTransport.start();

      this.isRunning = true;
      logger.info('NostrMCPGateway started successfully');
    } catch (error) {
      logger.error('Failed to start NostrMCPGateway:', error);
      await this.stop();
      throw error;
    }
  }

  /**
   * Stops the gateway, closing both transports.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      // Stop both transports
      await this.nostrServerTransport.close();
      await this.mcpClientTransport.close();

      this.isRunning = false;
      logger.info('NostrMCPGateway stopped successfully');
    } catch (error) {
      logger.error('Error stopping NostrMCPGateway:', error);
      throw error;
    }
  }

  /**
   * Handles errors from the Nostr transport.
   * @param error The error that occurred.
   */
  private handleNostrError(error: Error): void {
    logger.error('Nostr transport error:', error);
  }

  /**
   * Handles the Nostr transport closing.
   */
  private handleNostrClose(): void {
    logger.info('Nostr transport closed');
  }

  /**
   * Handles errors from the MCP server transport.
   * @param error The error that occurred.
   */
  private handleServerError(error: Error): void {
    logger.error('MCP server transport error:', error);
  }

  /**
   * Handles the MCP server transport closing.
   */
  private handleServerClose(): void {
    logger.info('MCP server transport closed');
  }

  /**
   * Gets the current status of the gateway.
   * @returns True if the gateway is running, false otherwise.
   */
  public isActive(): boolean {
    return this.isRunning;
  }
}
