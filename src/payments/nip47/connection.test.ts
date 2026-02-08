import { describe, expect, test } from 'bun:test';
import { parseNwcConnectionString } from './connection.js';

describe('parseNwcConnectionString()', () => {
  test('parses host pubkey + multiple relay params', () => {
    const pubkey = 'b'.repeat(64);
    const secret = 'a'.repeat(64);
    const conn = parseNwcConnectionString(
      `nostr+walletconnect://${pubkey}?relay=wss://r1.example&relay=wss://r2.example&secret=${secret}`,
    );

    expect(conn.walletPubkey).toBe(pubkey);
    expect(conn.clientSecretKeyHex).toBe(secret);
    expect(conn.relays).toEqual(['wss://r1.example', 'wss://r2.example']);
  });

  test('parses pathname pubkey', () => {
    const pubkey = 'c'.repeat(64);
    const secret = 'd'.repeat(64);
    const conn = parseNwcConnectionString(
      `nostr+walletconnect://ignored-host/${pubkey}?relay=wss://relay.example&secret=${secret}`,
    );
    expect(conn.walletPubkey).toBe(pubkey);
  });
});
