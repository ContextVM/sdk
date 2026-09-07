import { describe, it, expect } from 'bun:test';
import type { NostrEvent } from 'nostr-tools';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import type { RelayHandler } from '../core/interfaces.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import { CTXVM_MESSAGES_KIND } from '../core/index.js';

/**
 * Regression tests for per-request state release when an inbound request is
 * dropped by middleware (gating) or fails the chain: the correlation route AND
 * the open-stream writer reservation must both be released. A dropped request
 * never produces the normal-path response that would otherwise reap them.
 */
describe.serial('NostrServerTransport dropped-request state release', () => {
  function makeTransport(): NostrServerTransport {
    const relayHandler = {
      async connect() {},
      async disconnect() {},
      async publish() {},
      async subscribe() {
        return () => {};
      },
    } as unknown as RelayHandler;

    return new NostrServerTransport({
      signer: new PrivateKeySigner('1'.repeat(64)),
      relayHandler,
      encryptionMode: EncryptionMode.DISABLED,
      openStream: { enabled: true },
    });
  }

  const clientSk = generateSecretKey();
  const serverPubkey = getPublicKey(
    Uint8Array.from(Buffer.from('1'.repeat(64), 'hex')),
  );

  let seq = 0;
  function pricedToolRequestEvent(): NostrEvent {
    seq += 1;
    return finalizeEvent(
      {
        kind: CTXVM_MESSAGES_KIND,
        created_at: Math.floor(Date.now() / 1000) + seq,
        tags: [['p', serverPubkey]],
        content: JSON.stringify({
          jsonrpc: '2.0' as const,
          id: seq,
          method: 'tools/call',
          params: {
            name: 'expensive_tool',
            arguments: {},
            _meta: { progressToken: `tok-${seq}` },
          },
        }),
      },
      clientSk,
    );
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('releases the route and writer reservation when middleware drops a request', async () => {
    const transport = makeTransport();
    transport.onmessage = () => {};
    // Simulate any gating drop: response sent out-of-band, request never forwarded.
    transport.addInboundMiddleware(async () => {});

    const event = pricedToolRequestEvent();
    await transport['processIncomingEvent'](event);
    await settle();

    const state = transport.getInternalStateForTesting();
    expect(state.correlationStore.getEventRoute(event.id)).toBeUndefined();
    expect(transport.getOpenStreams()).toEqual([]);
    await transport.close();
  });

  it('releases the route and writer reservation when the middleware chain throws', async () => {
    const transport = makeTransport();
    transport.onmessage = () => {};
    transport.onerror = () => {}; // swallow chain error
    transport.addInboundMiddleware(async () => {
      throw new Error('middleware exploded');
    });

    const event = pricedToolRequestEvent();
    await transport['processIncomingEvent'](event);
    await settle();

    const state = transport.getInternalStateForTesting();
    expect(state.correlationStore.getEventRoute(event.id)).toBeUndefined();
    expect(transport.getOpenStreams()).toEqual([]);
    await transport.close();
  });

  it('keeps reaping via the normal response path when the request is forwarded', async () => {
    const transport = makeTransport();
    transport.onmessage = () => {};
    transport.addInboundMiddleware(async (msg, _ctx, forward) => {
      await forward(msg);
    });

    const event = pricedToolRequestEvent();
    await transport['processIncomingEvent'](event);
    await settle();
    // Normal path: writer exists until the response routes through the router.
    expect(transport.getOpenStreams().length).toBe(1);

    await transport.send({
      jsonrpc: '2.0',
      id: event.id,
      result: { ok: true },
    });

    expect(transport.getOpenStreams()).toEqual([]);
    await transport.close();
  });

  it('lifts the probe-eviction blacklist once the client re-establishes a session', async () => {
    const transport = makeTransport();
    transport.onmessage = () => {};
    const state = transport.getInternalStateForTesting();
    const clientPubkey = 'ab'.repeat(32);

    // Simulate a probe-timeout eviction whose pending response never routed.
    (
      state.openStreamFactory as unknown as {
        evictedClientPubkeys: Set<string>;
      }
    ).evictedClientPubkeys.add(clientPubkey);

    // No session: the evicted (zombie) client is still refused.
    await expect(
      transport.sendNotification(clientPubkey, {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: {},
      }),
    ).rejects.toThrow('No active session found for client');

    // The client reconnects (a fresh session exists): the blacklist must lift
    // so notification delivery — including payment_required — works again,
    // instead of throwing forever while responses still deliver.
    state.sessionStore.getOrCreateSession(clientPubkey, false);
    await transport.sendNotification(clientPubkey, {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: {},
    });
    expect(state.openStreamFactory.isClientEvicted(clientPubkey)).toBe(false);

    await transport.close();
  });
});
