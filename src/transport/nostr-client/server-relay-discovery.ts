import type { NostrEvent } from 'nostr-tools';
import {
  DEFAULT_TIMEOUT_MS,
  NOSTR_TAGS,
  RELAY_LIST_METADATA_KIND,
} from '../../core/index.js';
import { ApplesauceRelayPool } from '../../relay/applesauce-relay-pool.js';
import { withTimeout } from '../../core/utils/utils.js';

export interface RelayListEntry {
  url: string;
  marker?: string;
}

function normalizeRelayUrls(relayUrls: string[]): string[] {
  return [...new Set(relayUrls.filter((relayUrl) => relayUrl.length > 0))];
}

/**
 * Select a minimal operational relay set from a CEP-17 relay list.
 * Prefers unmarked relays as the recommended ContextVM profile.
 */
export function selectOperationalRelayUrls(
  entries: RelayListEntry[],
): string[] {
  const unmarked = normalizeRelayUrls(
    entries.filter((entry) => !entry.marker).map((entry) => entry.url),
  );

  if (unmarked.length > 0) {
    return unmarked;
  }

  const read = normalizeRelayUrls(
    entries
      .filter((entry) => entry.marker === 'read')
      .map((entry) => entry.url),
  );
  const write = normalizeRelayUrls(
    entries
      .filter((entry) => entry.marker === 'write')
      .map((entry) => entry.url),
  );

  return normalizeRelayUrls([...read, ...write]);
}

/**
 * Fetch the latest relay-list metadata event for a server from discovery relays.
 */
export async function fetchServerRelayList(params: {
  serverPubkey: string;
  relayUrls: string[];
}): Promise<RelayListEntry[]> {
  const relayPool = new ApplesauceRelayPool(params.relayUrls);
  const discoveredEvents: NostrEvent[] = [];

  try {
    await withTimeout(
      relayPool.connect(),
      DEFAULT_TIMEOUT_MS,
      'Connection to discovery relays timed out',
    );

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        let unsubscribe: (() => void) | undefined;

        void relayPool
          .subscribe(
            [
              {
                kinds: [RELAY_LIST_METADATA_KIND],
                authors: [params.serverPubkey],
              },
            ],
            (event) => {
              discoveredEvents.push(event);
            },
            () => {
              try {
                unsubscribe?.();
              } finally {
                resolve();
              }
            },
          )
          .then((value) => {
            unsubscribe = value;
          })
          .catch(reject);
      }),
      DEFAULT_TIMEOUT_MS,
      'Server relay-list discovery timed out',
    );
  } finally {
    await relayPool.disconnect().catch(() => undefined);
  }

  const latestEvent = discoveredEvents.sort(
    (left, right) => right.created_at - left.created_at,
  )[0];

  if (!latestEvent) {
    return [];
  }

  return latestEvent.tags
    .filter((tag) => tag[0] === NOSTR_TAGS.RELAY && typeof tag[1] === 'string')
    .map((tag) => ({
      url: tag[1],
      marker: typeof tag[2] === 'string' ? tag[2] : undefined,
    }));
}
