import { sleep } from '../core/utils/utils.js';
import {
  startMockRelay,
  type MockRelayInstance,
  type MockRelayStartOptions,
} from './mock-relay-server.js';

type SpawnedMockRelay = {
  relay: MockRelayInstance;
  relayUrl: string;
  httpUrl: string;
  port: number;
  stop: () => void;
};

/**
 * Waits for the mock relay to be ready by polling its HTTP endpoint.
 * @param relayUrl - The WebSocket URL of the relay (e.g., ws://localhost:PORT)
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @throws Error if the relay doesn't become ready within the timeout
 */
export async function waitForRelayReady(
  relayUrl: string,
  timeoutMs: number = 10000,
): Promise<void> {
  const httpUrl = relayUrl.replace('ws://', 'http://');
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(httpUrl, {
        method: 'GET',
        headers: { Accept: 'application/nostr+json' },
      });
      // Any response means the server is bound and accepting connections
      if (response.status === 200 || response.status === 404) {
        return;
      }
    } catch {
      // Server not ready yet, retry
    }
    await sleep(50);
  }

  throw new Error(
    `Relay at ${relayUrl} did not become ready within ${timeoutMs}ms`,
  );
}

/**
 * Starts an in-process mock relay on a dynamically allocated port.
 * @returns Object containing relay controls and endpoint URLs.
 */
export async function spawnMockRelay(): Promise<SpawnedMockRelay> {
  return spawnMockRelayWithEnv({});
}

/**
 * Starts an in-process mock relay with behavior configured from env-like flags.
 */
export async function spawnMockRelayWithEnv(
  env: Record<string, string>,
  port?: number,
): Promise<SpawnedMockRelay> {
  const options: MockRelayStartOptions = {
    port,
    unresponsive: env.UNRESPONSIVE === 'true',
    purgeIntervalSeconds:
      env.PURGE_INTERVAL !== undefined ? Number(env.PURGE_INTERVAL) : undefined,
  };

  const startTimeoutMs = 5000;
  const startTime = Date.now();

  // When restarting a relay on a fixed port, the OS may not release the socket
  // immediately (TIME_WAIT). Retry binds for a short window to avoid flakes.
  const startWithRetries = async (): Promise<MockRelayInstance> => {
    // Fast path: dynamic port bind is not expected to conflict.
    if (options.port === undefined || options.port === 0) {
      return startMockRelay(options);
    }

    let lastError: unknown;
    while (Date.now() - startTime < startTimeoutMs) {
      try {
        return startMockRelay(options);
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (/EADDRINUSE|in use/i.test(msg)) {
          await sleep(50);
          continue;
        }
        throw error;
      }
    }

    const msg =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `Timeout starting mock relay on fixed port ${options.port}: ${msg}`,
    );
  };

  const relay = await startWithRetries();
  // When running in-process, binding is synchronous. One quick probe keeps test
  // intent consistent (HTTP endpoint answers before we proceed).
  await waitForRelayReady(relay.relayUrl);

  return {
    relay,
    relayUrl: relay.relayUrl,
    httpUrl: relay.httpUrl,
    port: relay.port,
    stop: relay.stop,
  };
}

/**
 * Restarts an existing relay *on the same port* without releasing the port.
 *
 * This avoids flaky EADDRINUSE errors on fast restarts (TIME_WAIT) while still
 * exercising client reconnect logic.
 */
export async function restartMockRelay(
  current: MockRelayInstance,
  env: Record<string, string> = {},
): Promise<MockRelayInstance> {
  current.pause();
  await sleep(250);
  current.setUnresponsive(env.UNRESPONSIVE === 'true');
  current.resume();
  await waitForRelayReady(current.relayUrl);
  return current;
}

/**
 * Starts an in-process mock relay on a specific port.
 * Use this when tests need deterministic same-port restart behavior.
 */
export async function spawnMockRelayOnPort(
  port: number,
): Promise<SpawnedMockRelay> {
  return spawnMockRelayWithEnv({}, port);
}

/**
 * Clears the relay's event cache.
 * @param httpUrl - The HTTP URL of the relay
 */
export async function clearRelayCache(httpUrl: string): Promise<void> {
  try {
    await fetch(`${httpUrl}/clear-cache`, { method: 'POST' });
  } catch {
    // Best effort cleanup helper for tests.
  }
}
