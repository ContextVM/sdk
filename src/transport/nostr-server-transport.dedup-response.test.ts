import { describe, it, expect } from 'bun:test';
import type { RelayHandler } from '../core/interfaces.js';
import type { NostrEvent } from 'nostr-tools';
import type { JSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { EncryptionMode } from '../core/interfaces.js';

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

describe('NostrServerTransport duplicate response prevention', () => {
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
});
