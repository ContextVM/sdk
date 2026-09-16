import { describe, it, expect } from 'bun:test';
import { nip19 } from 'nostr-tools';
import { parseServerIdentity } from './server-identity.js';

const HEX_PUBKEY =
  'd7dd5eb2d7b7c33b7e3a02ec22e5db4a5ab5c8d1c9b3c2e0e6d1a5c1e5b9a2c3';

describe('parseServerIdentity', () => {
  describe('hex pubkey', () => {
    it('accepts a valid 64-character lowercase hex pubkey', () => {
      const result = parseServerIdentity(HEX_PUBKEY);
      expect(result).toEqual({ pubkey: HEX_PUBKEY, relayUrls: [] });
    });

    it('accepts uppercase and mixed-case hex pubkeys', () => {
      const upper = HEX_PUBKEY.toUpperCase();
      expect(parseServerIdentity(upper)).toEqual({
        pubkey: upper,
        relayUrls: [],
      });

      const mixed =
        HEX_PUBKEY.slice(0, 32) + HEX_PUBKEY.slice(32).toUpperCase();
      expect(parseServerIdentity(mixed)).toEqual({
        pubkey: mixed,
        relayUrls: [],
      });
    });
  });

  describe('npub', () => {
    it('accepts a valid npub and returns the underlying pubkey', () => {
      const npub = nip19.npubEncode(HEX_PUBKEY);
      const result = parseServerIdentity(npub);
      expect(result).toEqual({ pubkey: HEX_PUBKEY, relayUrls: [] });
    });
  });

  describe('nprofile', () => {
    it('accepts an nprofile with relay hints', () => {
      const relays = ['wss://relay.one.example', 'wss://relay.two.example'];
      const nprofile = nip19.nprofileEncode({ pubkey: HEX_PUBKEY, relays });
      const result = parseServerIdentity(nprofile);
      expect(result).toEqual({ pubkey: HEX_PUBKEY, relayUrls: relays });
    });

    it('accepts an nprofile without relay hints', () => {
      const nprofile = nip19.nprofileEncode({ pubkey: HEX_PUBKEY });
      const result = parseServerIdentity(nprofile);
      expect(result).toEqual({ pubkey: HEX_PUBKEY, relayUrls: [] });
    });
  });

  describe('invalid input', () => {
    it('throws the stable transport-facing error for malformed input', () => {
      const input = 'not-a-valid-identity';
      expect(() => parseServerIdentity(input)).toThrow(
        `Invalid serverPubkey format: ${input}. Expected hex pubkey, npub, or nprofile.`,
      );
    });

    it('throws for unsupported nip19 identifiers (e.g. nsec)', () => {
      const nsec = nip19.nsecEncode(new Uint8Array(32).fill(1));
      expect(() => parseServerIdentity(nsec)).toThrow(
        `Invalid serverPubkey format: ${nsec}. Expected hex pubkey, npub, or nprofile.`,
      );
    });

    it('throws for empty input', () => {
      expect(() => parseServerIdentity('')).toThrow(
        'Invalid serverPubkey format: . Expected hex pubkey, npub, or nprofile.',
      );
    });

    it('throws for hex input that is too short or too long', () => {
      const short = HEX_PUBKEY.slice(0, 63);
      const long = HEX_PUBKEY + 'a';
      expect(() => parseServerIdentity(short)).toThrow(
        `Invalid serverPubkey format: ${short}. Expected hex pubkey, npub, or nprofile.`,
      );
      expect(() => parseServerIdentity(long)).toThrow(
        `Invalid serverPubkey format: ${long}. Expected hex pubkey, npub, or nprofile.`,
      );
    });

    it('throws for non-hex characters of the right length', () => {
      const nonHex = 'g'.repeat(64);
      expect(() => parseServerIdentity(nonHex)).toThrow(
        `Invalid serverPubkey format: ${nonHex}. Expected hex pubkey, npub, or nprofile.`,
      );
    });
  });
});
