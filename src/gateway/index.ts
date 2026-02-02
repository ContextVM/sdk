import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  NostrServerTransport,
  NostrServerTransportOptions,
} from '../transport/nostr-server-transport.js';
import { createLogger } from '../core/utils/logger.js';
import { LruCache } from '../core/utils/lru-cache.js';

const logger = createLogger('gateway');

type ClientPubkey = string;

type SessionTerminationCapableTransport = Transport & {
  terminateSession?: () => void | Promise<void>;
};

/**
 * Options for configuring the NostrMCPGateway.
 */
export interface NostrMCPGatewayOptions {
  /**
   * The MCP client transport (e.g., StdioClientTransport) to connect to the original MCP server.
   * Required unless `createMcpClientTransport` is provided.
   */
  mcpClientTransport?: Transport;
  /** Options for configuring the Nostr server transport */
  nostrTransportOptions: NostrServerTransportOptions;

  /**
   * Optional factory for creating per-client MCP transports keyed by Nostr client pubkey.
   * If provided, the gateway will isolate MCP sessions per pubkey.
   */
  createMcpClientTransport?: (ctx: {
    clientPubkey: ClientPubkey;
  }) => Transport | Promise<Transport>;

  /** Maximum number of per-client MCP transports to keep in memory. @default 1000 */
  maxClientTransports?: number;
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
  private readonly mcpClientTransport: Transport | undefined;
  private readonly nostrServerTransport: NostrServerTransport;
  private readonly createMcpClientTransport:
    | ((ctx: { clientPubkey: ClientPubkey }) => Transport | Promise<Transport>)
    | undefined;
  private readonly clientTransports: LruCache<Transport> | undefined;
  private readonly clientTransportPromises:
    | Map<ClientPubkey, Promise<Transport>>
    | undefined;
  private readonly handleNostrErrorBound: (error: Error) => void;
  private readonly handleNostrCloseBound: () => void;
  private readonly handleServerErrorBound: (error: Error) => void;
  private readonly handleServerCloseBound: () => void;
  private isRunning = false;

  constructor(options: NostrMCPGatewayOptions) {
    this.mcpClientTransport = options.mcpClientTransport;
    this.createMcpClientTransport = options.createMcpClientTransport;

    if (!this.mcpClientTransport && !this.createMcpClientTransport) {
      throw new Error(
        'NostrMCPGateway requires either mcpClientTransport (single-client mode) or createMcpClientTransport (per-client mode)',
      );
    }

    this.handleNostrErrorBound = this.handleNostrError.bind(this);
    this.handleNostrCloseBound = this.handleNostrClose.bind(this);
    this.handleServerErrorBound = this.handleServerError.bind(this);
    this.handleServerCloseBound = this.handleServerClose.bind(this);

    this.nostrServerTransport = new NostrServerTransport({
      ...options.nostrTransportOptions,
      onClientSessionEvicted: ({ clientPubkey }) =>
        this.closeClientTransport(clientPubkey),
    });

    if (this.createMcpClientTransport) {
      this.clientTransportPromises = new Map();
      this.clientTransports = new LruCache<Transport>(
        options.maxClientTransports ?? 1000,
        (clientPubkey, transport) => {
          this.closeTransportForEviction(clientPubkey, transport).catch(
            (err) => {
              logger.error('Error closing evicted MCP transport', {
                error: err instanceof Error ? err.message : String(err),
                clientPubkey,
              });
            },
          );
        },
      );
    }

    this.setupEventHandlers();
  }

  /**
   * Sets up event handlers for both transports.
   */
  private setupEventHandlers(): void {
    // Forward messages from Nostr to the MCP server, handling any potential errors.
    // Note: this handler is used for transport-internal messages too (e.g., public-server announcements),
    // which don't have a client pubkey context.
    this.nostrServerTransport.onmessage = (message: JSONRPCMessage) => {
      if (this.createMcpClientTransport) {
        // In per-client mode, we only forward messages that have pubkey context.
        // Internal transport messages (e.g., announcement traffic) should not be sent to an MCP server.
        return;
      }

      if (!this.mcpClientTransport) {
        throw new Error(
          'mcpClientTransport is required when not using per-client mode',
        );
      }
      logger.debug('Received message from Nostr:', message);
      this.mcpClientTransport.send(message).catch(this.handleServerErrorBound);
    };

    this.nostrServerTransport.onmessageWithContext = (
      message: JSONRPCMessage,
      ctx: { clientPubkey: ClientPubkey },
    ) => {
      logger.debug('Received message from Nostr (context):', {
        clientPubkey: ctx.clientPubkey,
        message,
      });
      this.getOrCreateClientTransport(ctx.clientPubkey)
        .then((transport) => transport.send(message))
        .catch(this.handleServerErrorBound);
    };
    this.nostrServerTransport.onerror = this.handleNostrErrorBound;
    this.nostrServerTransport.onclose = this.handleNostrCloseBound;

    // Forward messages from the MCP server to the Nostr transport, handling any potential errors.
    if (this.mcpClientTransport) {
      this.mcpClientTransport.onmessage = (message: JSONRPCMessage) => {
        logger.debug('Received message from MCP server:', message);
        this.nostrServerTransport
          .send(message)
          .catch(this.handleNostrErrorBound);
      };
      this.mcpClientTransport.onerror = this.handleServerErrorBound;
      this.mcpClientTransport.onclose = this.handleServerCloseBound;
    }
  }

  private async getOrCreateClientTransport(
    clientPubkey: ClientPubkey,
  ): Promise<Transport> {
    const createMcpClientTransport = this.createMcpClientTransport;
    const clientTransports = this.clientTransports;

    if (!createMcpClientTransport || !clientTransports) {
      if (!this.mcpClientTransport) {
        throw new Error(
          'mcpClientTransport is required when not using per-client mode',
        );
      }
      return this.mcpClientTransport;
    }

    const existing = clientTransports.get(clientPubkey);
    if (existing) {
      return existing;
    }

    const inflight = this.clientTransportPromises?.get(clientPubkey);
    if (inflight) {
      return inflight;
    }

    const createPromise = (async () => {
      const created = await createMcpClientTransport({ clientPubkey });

      created.onmessage = (message: JSONRPCMessage) => {
        logger.debug('Received message from MCP server (per-client):', {
          clientPubkey,
          message,
        });
        this.nostrServerTransport
          .send(message)
          .catch(this.handleNostrErrorBound);
      };
      created.onerror = this.handleServerErrorBound;
      created.onclose = this.handleServerCloseBound;

      await created.start();
      clientTransports.set(clientPubkey, created);
      return created;
    })();

    this.clientTransportPromises?.set(clientPubkey, createPromise);

    try {
      return await createPromise;
    } finally {
      this.clientTransportPromises?.delete(clientPubkey);
    }
  }

  private async closeClientTransport(
    clientPubkey: ClientPubkey,
  ): Promise<void> {
    if (!this.clientTransports) {
      return;
    }

    const inflight = this.clientTransportPromises?.get(clientPubkey);
    if (inflight) {
      // Best-effort: wait for creation to complete, then close.
      // (If creation fails, the promise will reject and there's nothing to close.)
      await inflight
        .then((transport) =>
          this.closeTransportForEviction(clientPubkey, transport),
        )
        .catch(() => undefined);
      this.clientTransportPromises?.delete(clientPubkey);
      this.clientTransports.delete(clientPubkey);
      return;
    }

    const transport = this.clientTransports.get(clientPubkey);
    if (!transport) {
      return;
    }
    this.clientTransports.delete(clientPubkey);
    await this.closeTransportForEviction(clientPubkey, transport);
  }

  private async closeTransportForEviction(
    clientPubkey: ClientPubkey,
    transport: Transport,
  ): Promise<void> {
    try {
      const maybeTerminable = transport as SessionTerminationCapableTransport;
      await maybeTerminable.terminateSession?.();
    } catch (error) {
      logger.warn('Failed to terminate MCP session', {
        error: error instanceof Error ? error.message : String(error),
        clientPubkey,
      });
    }

    try {
      await transport.close();
    } catch (error) {
      logger.warn('Failed to close MCP transport', {
        error: error instanceof Error ? error.message : String(error),
        clientPubkey,
      });
    }
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
      if (!this.createMcpClientTransport) {
        if (!this.mcpClientTransport) {
          throw new Error(
            'mcpClientTransport is required when not using per-client mode',
          );
        }
        await this.mcpClientTransport.start();
      }
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
    try {
      // Stop both transports
      await this.nostrServerTransport.close();

      if (this.clientTransportPromises?.size) {
        await Promise.allSettled(this.clientTransportPromises.values());
        this.clientTransportPromises.clear();
      }

      if (this.clientTransports) {
        const closePromises: Promise<void>[] = [];
        for (const [
          clientPubkey,
          transport,
        ] of this.clientTransports.entries()) {
          closePromises.push(
            this.closeTransportForEviction(clientPubkey, transport),
          );
        }
        this.clientTransports.clear();
        await Promise.all(closePromises);
      } else {
        if (!this.mcpClientTransport) {
          throw new Error(
            'mcpClientTransport is required when not using per-client mode',
          );
        }
        await this.mcpClientTransport.close();
      }

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
