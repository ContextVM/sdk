import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { NostrServerTransport } from './nostr-server-transport.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import type { NostrEvent } from 'nostr-tools';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { EncryptionMode } from '../core/interfaces.js';
import {
  CTXVM_MESSAGES_KIND,
  EPHEMERAL_GIFT_WRAP_KIND,
  GIFT_WRAP_KIND,
} from '../core/constants.js';
import { encryptMessage } from '../core/encryption.js';
import { waitFor } from '../core/utils/test.utils.js';

/**
 * Invariant: for a session established via an ephemeral-wrapped request
 * (kind 21059) whose client advertises no capability tags, the server must
 * never publish a relay-stored gift wrap (kind 1059) back to that client —
 * across every outbound form: normal responses (route), progress
 * notifications (sendNotification with a correlated route), and targeted
 * early-rejection responses (sendTargetedResponse).
 *
 * This pins the wrap-kind mirroring policy path-agnostically: a future send
 * path that forgets to thread the request's wrap kind shows up here as a
 * persistent 1059 event.
 */
describe.serial('server wrap-kind mirroring (OPTIONAL, divergence config)', () => {
  let relayHub: MockRelayHub;
  let server: McpServer;
  let serverTransport: NostrServerTransport;
  let serverPubkey: string;
  let clientPubkey: string;
  let clientSecretKey: Uint8Array;
  let rawPublisher: ReturnType<MockRelayHub['createRelayHandler']>;
  /** Wrap-kinded events the server published addressed to the raw client. */
  const serverWrapKinds: number[] = [];
  let toolStarted: (() => void) | undefined;
  let finishTool: (() => void) | undefined;

  /** Builds, signs, wraps (21059, no capability tags), and publishes a request. */
  const sendRawWrappedRequest = (request: object): NostrEvent => {
    const inner = finalizeEvent(
      {
        kind: CTXVM_MESSAGES_KIND,
        content: JSON.stringify(request),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      clientSecretKey,
    );
    const wrap = encryptMessage(
      JSON.stringify(inner),
      serverPubkey,
      EPHEMERAL_GIFT_WRAP_KIND,
    );
    void rawPublisher.publish(wrap);
    return inner;
  };

  beforeAll(async () => {
    relayHub = new MockRelayHub();

    const serverPrivateKey = bytesToHex(generateSecretKey());
    serverPubkey = getPublicKey(hexToBytes(serverPrivateKey));
    const clientPrivateKey = bytesToHex(generateSecretKey());
    clientSecretKey = hexToBytes(clientPrivateKey);
    clientPubkey = getPublicKey(clientSecretKey);

    server = new McpServer({ name: 'MirrorServer', version: '1.0.0' });
    server.registerTool(
      'slow',
      { title: 'slow', description: 'waits for the test' },
      async () => {
        toolStarted?.();
        await new Promise<void>((resolve) => {
          finishTool = resolve;
        });
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );

    // giftWrapMode defaults to OPTIONAL — the divergence configuration.
    serverTransport = new NostrServerTransport({
      signer: new PrivateKeySigner(serverPrivateKey),
      relayHandler: relayHub.createRelayHandler(),
      encryptionMode: EncryptionMode.OPTIONAL,
      serverInfo: {},
    });
    await server.connect(serverTransport);

    rawPublisher = relayHub.createRelayHandler();
    const collector = relayHub.createRelayHandler();
    await collector.subscribe(
      [{ kinds: [GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND] }],
      (event) => {
        if (event.tags.some((t) => t[0] === 'p' && t[1] === clientPubkey)) {
          serverWrapKinds.push(event.kind);
        }
      },
    );

    // MCP handshake from the raw client: initialize → response, then the
    // initialized notification so tools/call is accepted.
    sendRawWrappedRequest({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'raw-client', version: '0.0.0' },
      },
    });
    await waitFor({
      produce: () =>
        serverWrapKinds.filter((k) => k === EPHEMERAL_GIFT_WRAP_KIND).length >= 1
          ? true
          : undefined,
    });
    sendRawWrappedRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });

  afterAll(async () => {
    await server.close();
    relayHub.clear();
  });

  test('every server outbound form mirrors the ephemeral request wrap', async () => {
    const toolStartedPromise = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const baseline = serverWrapKinds.length;

    // In-flight request: its route stays registered while the tool runs.
    const callInner = sendRawWrappedRequest({
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    });
    await toolStartedPromise;

    // Progress notification correlated to the live route (route lookup path).
    await serverTransport.sendNotification(
      clientPubkey,
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 1 },
      },
      callInner.id,
    );

    // Targeted early-rejection response (explicit-gating form).
    await serverTransport.sendTargetedResponse(
      clientPubkey,
      {
        jsonrpc: '2.0',
        id: 'call-1',
        error: { code: -32042, message: 'Payment Required' },
      },
      callInner.id,
    );

    // Normal response once the tool completes (route() path).
    finishTool?.();
    await waitFor({
      produce: () =>
        serverWrapKinds.length - baseline >= 3 ? true : undefined,
    });

    // The invariant: nothing the server addressed to this client was
    // relay-stored, and all reply forms arrived as ephemeral wraps.
    expect(serverWrapKinds).not.toContain(GIFT_WRAP_KIND);
    expect(
      serverWrapKinds.every((k) => k === EPHEMERAL_GIFT_WRAP_KIND),
    ).toBe(true);
    expect(serverWrapKinds.length - baseline).toBeGreaterThanOrEqual(3);
  }, 15000);
});
