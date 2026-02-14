import { describe, expect, test } from 'bun:test';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { createZapRequest, getBolt11FromZapReceipt } from './zap-events.js';

describe('nip57/zap-events', () => {
  test('createZapRequest() creates a kind-9734 template with required tags', () => {
    const ev = createZapRequest({
      amountMsats: 21000,
      recipientPubkey: 'a'.repeat(64),
      relays: ['wss://relay.example'],
    });

    expect(ev.kind).toBe(9734);
    expect(ev.content).toBe('');
    expect(ev.tags).toEqual([
      ['relays', 'wss://relay.example'],
      ['amount', '21000'],
      ['p', 'a'.repeat(64)],
    ]);
  });

  test('finalizeEvent() can sign a zap request template', () => {
    const sk = generateSecretKey();
    const template = createZapRequest({
      amountMsats: 1000,
      recipientPubkey: 'b'.repeat(64),
      relays: ['wss://relay.example'],
    });
    const signed = finalizeEvent(template, sk);

    expect(typeof signed.id).toBe('string');
    expect(signed.id.length).toBe(64);
    expect(typeof signed.sig).toBe('string');
    expect(signed.sig.length).toBeGreaterThan(0);
  });

  test('getBolt11FromZapReceipt() returns the bolt11 tag', () => {
    const receipt = {
      id: 'c'.repeat(64),
      pubkey: 'd'.repeat(64),
      created_at: 0,
      kind: 9735,
      tags: [['bolt11', 'lnbc1test']],
      content: '',
      sig: 'e'.repeat(128),
    };

    expect(getBolt11FromZapReceipt(receipt)).toBe('lnbc1test');
  });
});
