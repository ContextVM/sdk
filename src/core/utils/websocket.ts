type WebSocketConstructor = typeof globalThis.WebSocket;

function resolveGlobalWebSocket(): WebSocketConstructor | undefined {
  return typeof globalThis.WebSocket === 'function'
    ? globalThis.WebSocket
    : undefined;
}

function resolveNodeWebSocket(): WebSocketConstructor | undefined {
  try {
    const nodeProcess = globalThis.process as
      | (NodeJS.Process & {
          getBuiltinModule?: (id: string) => unknown;
        })
      | undefined;

    const moduleBuiltin = nodeProcess?.getBuiltinModule?.('module') as
      | {
          createRequire?: (filename: string) => NodeJS.Require;
        }
      | undefined;

    const require = moduleBuiltin?.createRequire?.(import.meta.url);

    if (!require) {
      return undefined;
    }

    const wsModule = require('ws') as {
      WebSocket?: WebSocketConstructor;
      default?: WebSocketConstructor;
    };

    return wsModule.WebSocket ?? wsModule.default;
  } catch {
    return undefined;
  }
}

export function ensureWebSocket(): WebSocketConstructor {
  const existing = resolveGlobalWebSocket();

  if (existing) {
    return existing;
  }

  const fallback = resolveNodeWebSocket();

  if (!fallback) {
    throw new Error(
      'WebSocket runtime support is unavailable. Install a compatible WebSocket implementation or run in a runtime that provides global WebSocket.',
    );
  }

  globalThis.WebSocket = fallback;
  return fallback;
}
