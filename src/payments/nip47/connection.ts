import { z } from 'zod';
import type { NwcConnection } from './types.js';

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/i);
const PubkeyHex = z.string().regex(/^[0-9a-f]{64}$/i);

function normalizeRelayUrl(relay: string): string {
  // Minimal normalization (we can tighten later).
  return relay.trim();
}

/**
 * Parses a Nostr Wallet Connect connection string.
 *
 * Example:
 * `nostr+walletconnect://<wallet_pubkey>?relay=wss://...&relay=wss://...&secret=<hex>`
 */
export function parseNwcConnectionString(
  connectionString: string,
): NwcConnection {
  const url = new URL(connectionString);

  // NIP-47 uses protocol `nostr+walletconnect://` and places the wallet pubkey
  // in either host or pathname (implementations differ).
  const walletPubkeyRaw = (url.pathname?.replace(/^\//, '') || url.host).trim();
  const secret = url.searchParams.get('secret')?.trim();

  const relayParams = url.searchParams.getAll('relay');
  const relays = relayParams.map(normalizeRelayUrl).filter(Boolean);

  if (!walletPubkeyRaw || !secret || relays.length === 0) {
    throw new Error('Invalid NWC connection string');
  }

  const walletPubkey = PubkeyHex.parse(walletPubkeyRaw);
  const clientSecretKeyHex = Hex32.parse(secret);

  return {
    walletPubkey,
    relays,
    clientSecretKeyHex,
  };
}
