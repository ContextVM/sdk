import { describe, expect, test } from 'bun:test';
import type { Filter, NostrEvent } from 'nostr-tools';
import { nip04 } from 'nostr-tools';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import type { RelayHandler } from '../../core/interfaces.js';
import type { NwcConnection } from './types.js';
import {
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  NwcClient,
} from './nwc-client.js';

class MockRelayHandler implements RelayHandler {
  public published: NostrEvent[] = [];
  public subscribedFilters: Filter[] | undefined;
  private onEvent: ((event: NostrEvent) => void) | undefined;

  async connect(): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async publish(_event: NostrEvent): Promise<void> {
    this.published.push(_event);
  }

  async subscribe(filters: Filter[], onEvent: (event: NostrEvent) => void) {
    this.subscribedFilters = filters;
    this.onEvent = onEvent;
    return () => {
      this.onEvent = undefined;
    };
  }

  unsubscribe(): void {
    this.onEvent = undefined;
  }

  emit(event: NostrEvent): void {
    this.onEvent?.(event);
  }
}

describe('NwcClient', () => {
  test('publishes NIP-47 request and resolves on correlated response (nip04)', async () => {
    const clientSecretKey = generateSecretKey();
    const clientSecretKeyHex = bytesToHex(clientSecretKey);
    const clientPubkey = getPublicKey(clientSecretKey);

    const walletSecretKey = generateSecretKey();
    const walletPubkey = getPublicKey(walletSecretKey);

    const relayHandler = new MockRelayHandler();
    const connection: NwcConnection = {
      walletPubkey,
      relays: ['wss://relay.example'],
      clientSecretKeyHex,
    };

    const client = new NwcClient({
      relayHandler,
      connection,
      responseTimeoutMs: 5_000,
    });
    const promise = client.request({
      method: 'pay_invoice',
      resultType: 'pay_invoice',
      request: { method: 'pay_invoice', params: { invoice: 'lnbc1...' } },
    });

    // Wait for publish.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(relayHandler.published.length).toBe(1);
    const requestEvent = relayHandler.published[0];
    expect(requestEvent.kind).toBe(NWC_REQUEST_KIND);

    // Decrypt the request with wallet keys (wallet side) to ensure it is nip04.
    const decryptedRequest = nip04.decrypt(
      bytesToHex(walletSecretKey),
      requestEvent.pubkey,
      requestEvent.content,
    );
    expect(JSON.parse(decryptedRequest)).toEqual({
      method: 'pay_invoice',
      params: { invoice: 'lnbc1...' },
    });

    const responsePayload = {
      result_type: 'pay_invoice',
      error: null,
      result: { preimage: '00'.repeat(32) },
    };
    const encryptedContent = nip04.encrypt(
      bytesToHex(walletSecretKey),
      clientPubkey,
      JSON.stringify(responsePayload),
    );

    const responseEventTemplate = {
      kind: NWC_RESPONSE_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: encryptedContent,
      tags: [
        ['p', clientPubkey],
        ['e', requestEvent.id],
      ],
    } satisfies Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>;
    const responseEvent = finalizeEvent(responseEventTemplate, walletSecretKey);
    relayHandler.emit(responseEvent);

    const resp = await promise;
    expect(resp.error).toBeNull();
    expect(resp.result_type).toBe('pay_invoice');
    expect((resp.result as { preimage: string }).preimage.length).toBe(64);
  });
});
