import { describe, it, expect } from 'bun:test';
import type { RelayHandler } from '../core/interfaces.js';
import type { NostrEvent } from 'nostr-tools';
import type { JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';
import {
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
  NOSTR_TAGS,
} from '../core/constants.js';

function makeCountingRelayHandler(counter: {
  publishCalls: number;
}): RelayHandler {
  return {
    async connect() {},
    async disconnect() {},
    async publish(_event: NostrEvent) {
      counter.publishCalls += 1;
    },
    async subscribe() {
      return () => {};
    },
  } as unknown as RelayHandler;
}

function makeCapturingRelayHandler(events: NostrEvent[]): RelayHandler {
  return {
    async connect() {},
    async disconnect() {},
    async publish(event: NostrEvent) {
      events.push(event);
    },
    async subscribe() {
      return () => {};
    },
  } as unknown as RelayHandler;
}

describe.serial('NostrServerTransport duplicate response prevention', () => {
  it('publishes at most once when send() is called concurrently with the same response id', async () => {
    const counter = { publishCalls: 0 };

    const transport = new NostrServerTransport({
      // PrivateKeySigner rejects 0 as an invalid private key.
      signer: new PrivateKeySigner('1'.repeat(64)),
      relayHandler: makeCountingRelayHandler(counter),
      encryptionMode: EncryptionMode.DISABLED,
    });

    // Seed state so handleResponse can route.
    const state = transport.getInternalStateForTesting();
    state.sessionStore.getOrCreateSession('c'.repeat(64), false);
    state.correlationStore.registerEventRoute('event1', 'c'.repeat(64), 123);

    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: 'event1',
      result: { ok: true },
    };

    // Two concurrent sends of the same response id.
    await Promise.all([
      transport.send(response),
      transport.send({ ...response }),
    ]);

    expect(counter.publishCalls).toBe(1);
  });

  it('processes a decrypted inner request only once even if delivered in multiple gift-wrap envelopes', async () => {
    const counter = { publishCalls: 0 };

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner('1'.repeat(64)),
      relayHandler: makeCountingRelayHandler(counter),
      encryptionMode: EncryptionMode.REQUIRED,
    });

    // Make decryptMessage deterministically return the same inner event id for both envelopes.
    const signer = transport['signer'];
    let decryptCalls = 0;
    signer.nip44 = {
      encrypt: async () => {
        throw new Error('encrypt not used in this test');
      },
      decrypt: async () => {
        decryptCalls += 1;
        return JSON.stringify({
          id: 'inner-request-id',
          kind: 25910,
          pubkey: 'c'.repeat(64),
          created_at: 1,
          tags: [['p', 's'.repeat(64)]],
          content: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          }),
          sig: '0'.repeat(128),
        } satisfies NostrEvent);
      },
    };

    // Two distinct gift-wrap envelopes (different outer ids) that decrypt to the same inner request.
    const gw1: NostrEvent = {
      id: 'gw1',
      kind: GIFT_WRAP_KIND,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      tags: [['p', 's'.repeat(64)]],
      content: 'ciphertext-1',
      sig: '0'.repeat(128),
    };
    const gw2: NostrEvent = {
      id: 'gw2',
      kind: GIFT_WRAP_KIND,
      pubkey: 'b'.repeat(64),
      created_at: 1,
      tags: [['p', 's'.repeat(64)]],
      content: 'ciphertext-2',
      sig: '0'.repeat(128),
    };

    // Drive the transport directly: both envelopes should decrypt, but only the first inner event
    // should be processed (second should be dropped by inner-id dedupe).
    await transport['processIncomingEvent'](gw1);
    await transport['processIncomingEvent'](gw2);

    expect(decryptCalls).toBe(2);
    // The transport should only process the inner request once.
    // We assert on correlation store size because requests register an event route.
    expect(
      transport.getInternalStateForTesting().correlationStore.eventRouteCount,
    ).toBe(1);
  });

  it('accepts ephemeral gift wrap envelopes (21059) when encryption is required', async () => {
    const counter = { publishCalls: 0 };

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner('1'.repeat(64)),
      relayHandler: makeCountingRelayHandler(counter),
      encryptionMode: EncryptionMode.REQUIRED,
    });

    // Deterministic decrypt.
    const signer = transport['signer'];
    signer.nip44 = {
      encrypt: async () => {
        throw new Error('encrypt not used in this test');
      },
      decrypt: async () =>
        JSON.stringify({
          id: 'inner-request-id-2',
          kind: 25910,
          pubkey: 'c'.repeat(64),
          created_at: 1,
          tags: [['p', 's'.repeat(64)]],
          content: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          }),
          sig: '0'.repeat(128),
        } satisfies NostrEvent),
    };

    const gw: NostrEvent = {
      id: 'gw-ephemeral',
      kind: EPHEMERAL_GIFT_WRAP_KIND,
      pubkey: 'a'.repeat(64),
      created_at: 1,
      tags: [['p', 's'.repeat(64)]],
      content: 'ciphertext',
      sig: '0'.repeat(128),
    };

    await transport['processIncomingEvent'](gw);

    expect(
      transport.getInternalStateForTesting().correlationStore.eventRouteCount,
    ).toBe(1);
  });

  it('sends common discovery tags only on the first oversized response frame', async () => {
    const publishedEvents: NostrEvent[] = [];

    const transport = new NostrServerTransport({
      signer: new PrivateKeySigner('1'.repeat(64)),
      relayHandler: makeCapturingRelayHandler(publishedEvents),
      encryptionMode: EncryptionMode.DISABLED,
      serverInfo: {
        name: 'Oversized Server',
        about: 'First frame carries discovery tags',
      },
      oversizedTransfer: {
        enabled: true,
        thresholdBytes: 32,
        chunkSizeBytes: 8,
      },
    });

    const state = transport.getInternalStateForTesting();
    const [session] = state.sessionStore.getOrCreateSession(
      'c'.repeat(64),
      false,
    );
    session.supportsOversizedTransfer = true;
    state.correlationStore.registerEventRoute(
      'event1',
      'c'.repeat(64),
      123,
      'token-1',
    );

    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: 'event1',
      result: {
        payload:
          'This response is intentionally long enough to force oversized transfer.',
      },
    };

    await transport.send(response);

    expect(publishedEvents.length).toBeGreaterThanOrEqual(3);

    const firstTags = publishedEvents[0]?.tags ?? [];
    const secondTags = publishedEvents[1]?.tags ?? [];

    expect(
      firstTags.some((tag) => tag[0] === NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER),
    ).toBe(true);
    expect(
      firstTags.some(
        (tag) => tag[0] === NOSTR_TAGS.NAME && tag[1] === 'Oversized Server',
      ),
    ).toBe(true);
    expect(
      firstTags.some(
        (tag) =>
          tag[0] === NOSTR_TAGS.ABOUT &&
          tag[1] === 'First frame carries discovery tags',
      ),
    ).toBe(true);

    expect(
      secondTags.some(
        (tag) => tag[0] === NOSTR_TAGS.SUPPORT_OVERSIZED_TRANSFER,
      ),
    ).toBe(false);
    expect(secondTags.some((tag) => tag[0] === NOSTR_TAGS.NAME)).toBe(false);
    expect(secondTags.some((tag) => tag[0] === NOSTR_TAGS.ABOUT)).toBe(false);

    expect(session.hasSentCommonTags).toBe(true);
  });
});
