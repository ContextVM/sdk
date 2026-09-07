import { describe, expect, test } from 'bun:test';
import type { Filter, NostrEvent } from 'nostr-tools';
import { kinds, nip04 } from 'nostr-tools';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import type { RelayHandler } from '../../core/interfaces.js';
import type { NwcConnection } from './types.js';
import {
  NWC_NOTIFICATION_KIND,
  NWC_NOTIFICATION_LEGACY_KIND,
  NwcClient,
} from './nwc-client.js';

class MockRelayHandler implements RelayHandler {
  public published: NostrEvent[] = [];
  public subscribedFilters: Filter[] | undefined;
  public unsubscribeCount = 0;
  /** When set, subscribe() resolves only after this delay (ms). */
  public subscribeDelayMs = 0;
  private onEvent: ((event: NostrEvent) => void) | undefined;

  getRelayUrls(): string[] {
    return ['wss://relay.example'];
  }

  async connect(): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async publish(_event: NostrEvent): Promise<void> {
    this.published.push(_event);
  }

  async subscribe(
    filters: Filter[],
    onEvent: (event: NostrEvent) => void,
  ): Promise<() => void> {
    this.subscribedFilters = filters;
    if (this.subscribeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.subscribeDelayMs));
    }
    this.onEvent = onEvent;
    return () => {
      this.unsubscribeCount += 1;
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
    expect(requestEvent.kind).toBe(kinds.NWCWalletRequest);

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
      kind: kinds.NWCWalletResponse,
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

  test('subscribes to notification kinds and decrypts nip04 payload', async () => {
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

    const received: Array<{
      notification_type: string;
      notification: unknown;
    }> = [];
    await client.subscribeNotifications({
      onNotification: (p) => received.push(p),
    });

    // Ensure filters include both kinds.
    expect(relayHandler.subscribedFilters?.[0]?.kinds).toEqual([
      NWC_NOTIFICATION_KIND,
      NWC_NOTIFICATION_LEGACY_KIND,
    ]);

    const payload = {
      notification_type: 'payment_received',
      notification: { payment_hash: 'a'.repeat(64) },
    };
    const encryptedContent = nip04.encrypt(
      bytesToHex(walletSecretKey),
      clientPubkey,
      JSON.stringify(payload),
    );

    relayHandler.emit({
      kind: NWC_NOTIFICATION_KIND,
      created_at: Math.floor(Date.now() / 1000),
      content: encryptedContent,
      tags: [['p', clientPubkey]],
      pubkey: walletPubkey,
      id: 'e'.repeat(64),
      sig: 'f'.repeat(128),
    });

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(received).toEqual([payload]);
  });

  test('unsubscribes the response subscription when the wallet never responds', async () => {
    const clientSecretKey = generateSecretKey();
    const walletPubkey = getPublicKey(generateSecretKey());

    const relayHandler = new MockRelayHandler();
    // subscribe() resolves only AFTER the response timeout fires — the exact
    // interleaving that used to leak the subscription forever.
    relayHandler.subscribeDelayMs = 80;

    const client = new NwcClient({
      relayHandler,
      connection: {
        walletPubkey,
        relays: ['wss://relay.example'],
        clientSecretKeyHex: bytesToHex(clientSecretKey),
      },
      responseTimeoutMs: 20,
    });

    await expect(
      client.request({
        method: 'pay_invoice',
        resultType: 'pay_invoice',
        request: { method: 'pay_invoice', params: { invoice: 'lnbc1...' } },
      }),
    ).rejects.toThrow(/NWC response timed out/);

    // Give the late-resolving subscribe().then() a chance to run.
    await new Promise<void>((r) => setTimeout(r, 150));
    expect(relayHandler.unsubscribeCount).toBe(1);
  });
});
