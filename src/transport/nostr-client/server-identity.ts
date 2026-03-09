import { nip19 } from 'nostr-tools';

export interface ParsedServerIdentity {
  pubkey: string;
  relayUrls: string[];
}

function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Parse a server identity accepted by the client transport.
 * Supports hex pubkeys, npub, and nprofile identifiers.
 */
export function parseServerIdentity(input: string): ParsedServerIdentity {
  if (isHexPubkey(input)) {
    return {
      pubkey: input,
      relayUrls: [],
    };
  }

  try {
    const decoded = nip19.decode(input);

    if (decoded.type === 'npub') {
      return {
        pubkey: decoded.data,
        relayUrls: [],
      };
    }

    if (decoded.type === 'nprofile') {
      return {
        pubkey: decoded.data.pubkey,
        relayUrls: decoded.data.relays ?? [],
      };
    }
  } catch {
    // Fall through to a single transport-facing error below.
  }

  throw new Error(
    `Invalid serverPubkey format: ${input}. Expected hex pubkey, npub, or nprofile.`,
  );
}
