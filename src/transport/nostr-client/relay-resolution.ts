import { DEFAULT_TIMEOUT_MS } from '../../core/constants.js';
import type { Logger } from '../../core/utils/logger.js';
import { withTimeout } from '../../core/utils/utils.js';
import { ApplesauceRelayPool } from '../../relay/applesauce-relay-pool.js';
import {
  fetchServerRelayList,
  selectOperationalRelayUrls,
} from './server-relay-discovery.js';

/**
 * Dependencies required to apply resolved relay URLs and emit logs.
 */
export interface RelayResolutionDeps {
  setRelayHandler: (urls: string[]) => void;
  logger: Logger;
}

/**
 * Inputs used to resolve operational relays for a client transport.
 */
export interface RelayResolutionConfig {
  configuredRelayUrls: string[];
  hintedRelayUrls: readonly string[];
  discoveryRelayUrls: readonly string[];
  fallbackOperationalRelayUrls: readonly string[];
  serverPubkey: string;
}

/**
 * Resolves and applies operational relays using configured URLs, hints, discovery, and fallback probing.
 */
export async function resolveOperationalRelays(
  config: RelayResolutionConfig,
  deps: RelayResolutionDeps,
): Promise<void> {
  if (config.configuredRelayUrls.length > 0) {
    return;
  }

  if (config.hintedRelayUrls.length > 0) {
    deps.logger.info('Using relay hints from server identity', {
      relayCount: config.hintedRelayUrls.length,
    });
    deps.setRelayHandler([...config.hintedRelayUrls]);
    return;
  }

  if (config.discoveryRelayUrls.length === 0) {
    if (config.fallbackOperationalRelayUrls.length > 0) {
      deps.logger.info('Using configured fallback operational relays', {
        relayCount: config.fallbackOperationalRelayUrls.length,
      });
      deps.setRelayHandler([...config.fallbackOperationalRelayUrls]);
    }
    return;
  }

  const discoveryPromise = fetchServerRelayList({
    serverPubkey: config.serverPubkey,
    relayUrls: [...config.discoveryRelayUrls],
  }).then((relayListEntries) =>
    selectOperationalRelayUrls(relayListEntries).map((relayUrl) => relayUrl),
  );

  const fallbackConnectionPromise = connectFallbackOperationalRelays(
    config.fallbackOperationalRelayUrls,
  );

  const firstConnectedRelayUrls = await Promise.race([
    discoveryPromise,
    fallbackConnectionPromise,
  ]);

  if (firstConnectedRelayUrls.length > 0) {
    deps.logger.info('Resolved operational relays', {
      relayCount: firstConnectedRelayUrls.length,
    });
    deps.setRelayHandler(firstConnectedRelayUrls);
    return;
  }

  const [discoveryRelayUrls, fallbackRelayUrls] = await Promise.all([
    discoveryPromise,
    fallbackConnectionPromise,
  ]);

  if (discoveryRelayUrls.length > 0) {
    deps.logger.info('Resolved operational relays from server relay list', {
      relayCount: discoveryRelayUrls.length,
    });
    deps.setRelayHandler(discoveryRelayUrls);
    return;
  }

  if (fallbackRelayUrls.length > 0) {
    deps.logger.info('Using configured fallback operational relays', {
      relayCount: fallbackRelayUrls.length,
    });
    deps.setRelayHandler(fallbackRelayUrls);
    return;
  }

  deps.logger.warn(
    'No operational relays discovered from kind 10002; falling back to discovery relays',
    {
      relayCount: config.discoveryRelayUrls.length,
    },
  );
  deps.setRelayHandler([...config.discoveryRelayUrls]);
}

async function connectFallbackOperationalRelays(
  fallbackOperationalRelayUrls: readonly string[],
): Promise<string[]> {
  if (fallbackOperationalRelayUrls.length === 0) {
    return [];
  }

  const relayPool = new ApplesauceRelayPool([...fallbackOperationalRelayUrls]);

  try {
    await withTimeout(
      relayPool.connect(),
      DEFAULT_TIMEOUT_MS,
      'Fallback operational relay probing timed out',
    );
    return [...fallbackOperationalRelayUrls];
  } catch {
    return [];
  } finally {
    await relayPool.disconnect().catch(() => undefined);
  }
}
