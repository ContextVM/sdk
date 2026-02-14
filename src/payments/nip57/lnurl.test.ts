import { describe, expect, test } from 'bun:test';
import {
  fetchLnurlPayParams,
  parseLnAddress,
  requestZapInvoice,
} from './lnurl.js';

describe('nip57/lnurl', () => {
  test('parseLnAddress() parses a valid LUD-16 address', () => {
    expect(parseLnAddress('ContextVM@coinos.io')).toEqual({
      username: 'ContextVM',
      domain: 'coinos.io',
    });
  });

  test('parseLnAddress() rejects invalid input', () => {
    expect(() => parseLnAddress('not-an-address')).toThrow('Invalid lnAddress');
    expect(() => parseLnAddress('@domain.com')).toThrow('Invalid lnAddress');
    expect(() => parseLnAddress('user@')).toThrow('Invalid lnAddress');
    expect(() => parseLnAddress('a@b@c')).toThrow('Invalid lnAddress');
  });

  test('fetchLnurlPayParams() calls the well-known endpoint and returns callback', async () => {
    const originalFetch = globalThis.fetch;

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response(
        JSON.stringify({
          callback: 'https://example.com/callback',
          allowsNostr: true,
          nostrPubkey: 'f'.repeat(64),
          minSendable: 1000,
          maxSendable: 10_000,
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    try {
      const res = await fetchLnurlPayParams({ lnAddress: 'user@example.com' });
      expect(res.callback).toBe('https://example.com/callback');
      expect(calls[0]).toBe('https://example.com/.well-known/lnurlp/user');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('requestZapInvoice() attaches amount and nostr params and returns pr', async () => {
    const originalFetch = globalThis.fetch;

    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({ pr: 'lnbc1...' }), { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const res = await requestZapInvoice({
        callback: 'https://example.com/cb',
        amountMsats: 21000,
        zapRequestJson: '{"kind":9734}',
      });
      expect(res.pr).toBe('lnbc1...');

      const url = new URL(calls[0]!);
      expect(url.origin + url.pathname).toBe('https://example.com/cb');
      expect(url.searchParams.get('amount')).toBe('21000');
      expect(url.searchParams.get('nostr')).toBe('{"kind":9734}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Real-network smoke test (skipped by default).
  test('fetchLnurlPayParams() works against ContextVM@coinos.io', async () => {
    const res = await fetchLnurlPayParams({ lnAddress: 'ContextVM@coinos.io' });
    expect(typeof res.callback).toBe('string');
    expect(res.callback.length).toBeGreaterThan(0);
  });
});
