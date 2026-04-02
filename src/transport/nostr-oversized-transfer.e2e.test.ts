import { describe, expect, test } from 'bun:test';
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
} from '@modelcontextprotocol/sdk/types.js';
import type { NostrEvent } from 'nostr-tools';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { waitFor } from '../core/utils/test.utils.js';
import { EncryptionMode } from '../core/interfaces.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { DEFAULT_OVERSIZED_THRESHOLD } from './oversized-transfer/constants.js';

function getFrameType(event: NostrEvent): string | undefined {
  try {
    const message = JSON.parse(event.content) as {
      params?: {
        cvm?: {
          frameType?: string;
        };
      };
    };
    return message.params?.cvm?.frameType;
  } catch {
    return undefined;
  }
}

function parseRelayMessage(event: NostrEvent): unknown {
  try {
    return JSON.parse(event.content) as unknown;
  } catch {
    return event.content;
  }
}

function logRelayEvents(label: string, relayHub: MockRelayHub): void {
  const events = relayHub.getEvents();
  console.log(
    `[nostr-oversized-e2e] ${label}`,
    events.map((event, index) => ({
      index,
      id: event.id,
      pubkey: event.pubkey,
      kind: event.kind,
      tags: event.tags,
      frameType: getFrameType(event),
      message: parseRelayMessage(event),
    })),
  );
}

function makeLargeText(prefix: string, repeatCount: number): string {
  return `${prefix}:${'x'.repeat(repeatCount)}`;
}

describe('Nostr oversized transfer end-to-end', () => {
  test('reassembles an oversized client request after accept-gated stateless bootstrap', async () => {
    const relayHub = new MockRelayHub();
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());
    const clientPublicKey = getPublicKey(hexToBytes(clientPrivateKey));

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: serverPublicKey,
      isStateless: true,
      encryptionMode: EncryptionMode.DISABLED,
      oversizedTransfer: {
        enabled: true,
      },
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      encryptionMode: EncryptionMode.DISABLED,
      oversizedTransfer: {
        enabled: true,
      },
    });

    const capturedRequests: JSONRPCRequest[] = [];
    serverTransport.onmessage = (message: JSONRPCMessage) => {
      capturedRequests.push(message as JSONRPCRequest);
    };

    await serverTransport.start();
    await clientTransport.start();

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'large_tool',
        arguments: {
          payload: makeLargeText(
            'oversized-request',
            DEFAULT_OVERSIZED_THRESHOLD,
          ),
        },
        _meta: {
          progressToken: 'req-oversized-bootstrap',
        },
      },
    };

    await clientTransport.send(request).catch((error: unknown) => {
      logRelayEvents('client request send failure', relayHub);
      throw error;
    });

    const reconstructed = await waitFor({
      produce: () => capturedRequests[0],
      timeoutMs: 5_000,
    }).catch((error: unknown) => {
      logRelayEvents('client request reconstruction timeout', relayHub);
      throw error;
    });

    expect(reconstructed).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: request.params,
    });
    expect(typeof reconstructed.id).toBe('string');

    const relayEvents = await waitFor({
      produce: () => {
        const events = relayHub.getEvents();
        return events.length >= 4 ? [...events] : undefined;
      },
      timeoutMs: 5_000,
    }).catch((error: unknown) => {
      logRelayEvents('client request relay events timeout', relayHub);
      throw error;
    });

    const clientToServerFrames = relayEvents.filter(
      (event) => event.pubkey === clientPublicKey,
    );
    const serverToClientFrames = relayEvents.filter(
      (event) => event.pubkey === serverPublicKey,
    );

    expect(
      clientToServerFrames[0] && getFrameType(clientToServerFrames[0]),
    ).toBe('start');
    expect(
      serverToClientFrames.some((event) => getFrameType(event) === 'accept'),
    ).toBe(true);
    expect(
      clientToServerFrames.some((event) => getFrameType(event) === 'chunk'),
    ).toBe(true);
    expect(clientToServerFrames[clientToServerFrames.length - 1]).toBeDefined();
    expect(
      getFrameType(clientToServerFrames[clientToServerFrames.length - 1]!),
    ).toBe('end');

    await clientTransport.close();
    await serverTransport.close();
    relayHub.clear();
  }, 15_000);

  test('reassembles an oversized server response and learns oversized support from first response frame', async () => {
    const relayHub = new MockRelayHub();
    const serverPrivateKey = bytesToHex(generateSecretKey());
    const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());

    const clientTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(clientPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: serverPublicKey,
      isStateless: true,
      encryptionMode: EncryptionMode.DISABLED,
      oversizedTransfer: {
        enabled: true,
      },
    });

    const serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      encryptionMode: EncryptionMode.DISABLED,
      serverInfo: {
        name: 'Oversized E2E Server',
        about: 'Learns support from first oversized response frame',
      },
      oversizedTransfer: {
        enabled: true,
      },
    });

    const receivedResponses: JSONRPCResponse[] = [];
    const capturedRequests: JSONRPCRequest[] = [];
    const sendErrors: Error[] = [];
    clientTransport.onmessage = (message: JSONRPCMessage) => {
      receivedResponses.push(message as JSONRPCResponse);
    };

    serverTransport.onmessage = (message: JSONRPCMessage) => {
      const request = message as JSONRPCRequest;
      capturedRequests.push(request);
      const response: JSONRPCResponse = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          payload: makeLargeText(
            'oversized-response',
            DEFAULT_OVERSIZED_THRESHOLD,
          ),
        },
      };

      void serverTransport.send(response).catch((error: unknown) => {
        sendErrors.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    };

    await serverTransport.start();
    await clientTransport.start();

    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'large_tool',
        arguments: {},
        _meta: {
          progressToken: 'resp-oversized-render',
        },
      },
    };

    await clientTransport.send(request).catch((error: unknown) => {
      logRelayEvents('server response request send failure', relayHub);
      throw error;
    });

    const reconstructedRequest = await waitFor({
      produce: () => capturedRequests[0],
      timeoutMs: 5_000,
    }).catch((error: unknown) => {
      logRelayEvents(
        'server response request reconstruction timeout',
        relayHub,
      );
      throw error;
    });

    expect(reconstructedRequest).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: request.params,
    });

    const response = await waitFor({
      produce: () => receivedResponses[0],
      timeoutMs: 5_000,
    }).catch((error: unknown) => {
      console.log('[nostr-oversized-e2e] server send errors', sendErrors);
      logRelayEvents('server response timeout', relayHub);
      throw error;
    });

    expect(sendErrors).toEqual([]);

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        payload: makeLargeText(
          'oversized-response',
          DEFAULT_OVERSIZED_THRESHOLD,
        ),
      },
    });

    const learnedEvent = await waitFor({
      produce: () => clientTransport.getServerInitializeEvent(),
      predicate: (event) =>
        event.tags.some((tag) => tag[0] === 'support_oversized_transfer'),
      timeoutMs: 5_000,
    }).catch((error: unknown) => {
      logRelayEvents('server capability learning timeout', relayHub);
      throw error;
    });

    expect(
      learnedEvent.tags.some((tag) => tag[0] === 'support_oversized_transfer'),
    ).toBe(true);
    expect(clientTransport.getServerInitializeName()).toBe(
      'Oversized E2E Server',
    );
    expect(clientTransport.getServerInitializeAbout()).toBe(
      'Learns support from first oversized response frame',
    );

    await clientTransport.close();
    await serverTransport.close();
    relayHub.clear();
  }, 15_000);
});
