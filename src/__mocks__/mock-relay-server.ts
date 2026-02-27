import { serve, type Server, type ServerWebSocket } from 'bun';
import { matchFilter, matchFilters } from 'nostr-tools';
import type { Event, Filter } from 'nostr-tools';

// Message Types
type NostrClientMessage =
  | ['EVENT', Event]
  | ['REQ', string, ...Filter[]]
  | ['CLOSE', string];

type NostrRelayMessage =
  | ['EVENT', string, Event]
  | ['EOSE', string]
  | ['OK', string, boolean, string]
  | ['NOTICE', string];

export type MockRelayStartOptions = {
  /** Port to bind to. Defaults to 0 (OS-assigned). */
  port?: number;
  /** If true, the relay will not send EOSE responses (simulates half-open/unresponsive). */
  unresponsive?: boolean;
  /** If set, purges stored events every N seconds. */
  purgeIntervalSeconds?: number;
};

export type MockRelayInstance = {
  server: Server<unknown>;
  port: number;
  relayUrl: string;
  httpUrl: string;
  /** Stops the server and closes all active WebSocket connections. */
  stop: () => void;
  /**
   * Simulates the relay going offline without releasing the port.
   * Existing connections are closed and new WebSocket upgrades are rejected.
   */
  pause: () => void;
  /** Re-enables WebSocket upgrades after {@link pause}. */
  resume: () => void;
  /** Toggles unresponsive mode (connected but never responds to REQ). */
  setUnresponsive: (unresponsive: boolean) => void;
};

type ConnectionInstance = {
  cleanup: () => void;
  cleanupWithoutClosingSocket: () => void;
  closeSocket: (code: number, reason: string) => void;
  handle: (message: string) => void;
  send: (message: NostrRelayMessage) => void;
};

type State = {
  connCount: number;
  events: Event[];
  subs: Map<string, { instance: ConnectionInstance; filters: Filter[] }>;
  connections: Map<ServerWebSocket<unknown>, ConnectionInstance>;
  lastPurgeMs: number;
};

/**
 * Starts an in-process mock relay bound to an OS-assigned port by default.
 * This avoids TOCTOU port allocation races and removes the need for IPC.
 */
export function startMockRelay(
  options: MockRelayStartOptions = {},
): MockRelayInstance {
  const state: State = {
    connCount: 0,
    events: [],
    subs: new Map(),
    connections: new Map(),
    lastPurgeMs: Date.now(),
  };

  const runtime = {
    acceptingWs: true,
    unresponsive: options.unresponsive ?? false,
  };

  if (options.purgeIntervalSeconds !== undefined) {
    setInterval(() => {
      state.lastPurgeMs = Date.now();
      state.events = [];
    }, options.purgeIntervalSeconds * 1000);
  }

  class Instance implements ConnectionInstance {
    private socket: ServerWebSocket<unknown>;
    private subs = new Set<string>();
    private connectionId: string;

    constructor(socket: ServerWebSocket<unknown>) {
      this.socket = socket;
      this.connectionId = Math.random().toString(36).substring(2, 15);
    }

    closeSocket(code: number, reason: string): void {
      try {
        this.socket.close(code, reason);
      } catch {
        // ignore
      }
    }

    cleanup(): void {
      // Used by stop()/pause() to actively take the relay offline.
      // Close the socket first, then drop all subscriptions.
      this.closeSocket(1011, 'Relay offline');
      this.cleanupWithoutClosingSocket();
    }

    cleanupWithoutClosingSocket(): void {
      // Used by websocket.close() where the socket is already closed.
      // Avoid calling ws.close() from inside the close handler.
      for (const subId of this.subs) {
        this.removeSub(subId);
      }
    }

    addSub(subId: string, filters: Filter[]): void {
      const uniqueSubId = `${this.connectionId}:${subId}`;
      state.subs.set(uniqueSubId, { instance: this, filters });
      this.subs.add(uniqueSubId);
    }

    removeSub(uniqueSubId: string): void {
      state.subs.delete(uniqueSubId);
      this.subs.delete(uniqueSubId);
    }

    send(message: NostrRelayMessage): void {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(message));
      }
    }

    handle(message: string): void {
      let parsedMessage: NostrClientMessage;
      try {
        parsedMessage = JSON.parse(message) as NostrClientMessage;
      } catch {
        this.send(['NOTICE', 'Unable to parse message']);
        return;
      }

      const [verb, ...payload] = parsedMessage;

      switch (verb) {
        case 'EVENT':
          this.onEVENT(payload[0] as Event);
          break;
        case 'REQ':
          this.onREQ(payload[0] as string, ...(payload.slice(1) as Filter[]));
          break;
        case 'CLOSE':
          this.onCLOSE(payload[0] as string);
          break;
        default:
          this.send(['NOTICE', 'Unable to handle message']);
      }
    }

    onCLOSE(subId: string): void {
      const uniqueSubId = `${this.connectionId}:${subId}`;
      this.removeSub(uniqueSubId);
    }

    onREQ(subId: string, ...filters: Filter[]): void {
      this.addSub(subId, filters);

      if (runtime.unresponsive) {
        return;
      }

      for (const filter of filters) {
        let limitCount = filter.limit;
        if (limitCount !== undefined && limitCount <= 0) {
          continue;
        }
        for (const event of state.events) {
          if (limitCount === undefined || limitCount > 0) {
            if (matchFilter(filter, event)) {
              this.send(['EVENT', subId, event]);
              if (limitCount !== undefined) {
                limitCount--;
              }
            }
          }
        }
      }

      this.send(['EOSE', subId]);
    }

    onEVENT(event: Event): void {
      state.events = state.events
        .concat(event)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

      this.send(['OK', event.id, true, '']);

      for (const [uniqueSubId, { instance, filters }] of state.subs.entries()) {
        if (matchFilters(filters, event)) {
          const originalSubId = uniqueSubId.includes(':')
            ? uniqueSubId.split(':').slice(1).join(':')
            : uniqueSubId;
          instance.send(['EVENT', originalSubId, event]);
        }
      }
    }
  }

  const server = serve({
    port: options.port ?? 0,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === '/clear-cache' && req.method === 'POST') {
        state.events = [];
        return new Response('Cache cleared', { status: 200 });
      }

      if (
        url.pathname === '/' &&
        req.headers.get('accept') === 'application/nostr+json'
      ) {
        return new Response(
          JSON.stringify({
            name: 'Bucket',
            description: 'Just a dev relay',
          }),
          {
            headers: {
              'Content-Type': 'application/nostr+json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': '*',
              'Access-Control-Allow-Methods': '*',
            },
          },
        );
      }

      if (!runtime.acceptingWs) {
        return new Response('Relay paused', { status: 503 });
      }

      const success = server.upgrade(req);
      if (success) {
        return undefined;
      }

      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        state.connCount += 1;
        const relay = new Instance(ws);
        state.connections.set(ws, relay);

        if (options.purgeIntervalSeconds !== undefined) {
          const now = Date.now();
          relay.send([
            'NOTICE',
            'Next purge in ' +
              Math.round(
                (options.purgeIntervalSeconds * 1000 -
                  (now - state.lastPurgeMs)) /
                  1000,
              ) +
              ' seconds',
          ]);
        }
      },
      message(ws: ServerWebSocket<unknown>, message: string) {
        const relay = state.connections.get(ws);
        relay?.handle(message);
      },
      close(ws: ServerWebSocket<unknown>) {
        const relay = state.connections.get(ws);
        // The socket is already closed here; only release server-side state.
        relay?.cleanupWithoutClosingSocket();
        state.connections.delete(ws);
        state.connCount -= 1;
      },
    },
  });

  const port = server.port;
  if (typeof port !== 'number') {
    server.stop(true);
    throw new Error('Mock relay did not expose a numeric port');
  }

  return {
    server,
    port,
    relayUrl: `ws://localhost:${port}`,
    httpUrl: `http://localhost:${port}`,
    stop: () => {
      // Close any existing WebSocket connections before stopping the server.
      for (const instance of state.connections.values()) {
        instance.closeSocket(1001, 'Relay stopping');
        instance.cleanupWithoutClosingSocket();
      }
      state.connections.clear();
      state.subs.clear();
      server.stop(true);
    },
    pause: () => {
      runtime.acceptingWs = false;
      for (const instance of state.connections.values()) {
        // Close *uncleanly* so clients reconnect (applesauce-relay only retries on !wasClean).
        instance.closeSocket(1011, 'Relay paused');
        instance.cleanupWithoutClosingSocket();
      }
      state.connections.clear();
      state.subs.clear();
    },
    resume: () => {
      runtime.acceptingWs = true;
    },
    setUnresponsive: (unresponsive: boolean) => {
      runtime.unresponsive = unresponsive;
    },
  };
}
