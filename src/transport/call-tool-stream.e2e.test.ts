import { describe, expect, test } from 'bun:test';
import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import { z } from 'zod';
import { waitFor } from '../core/utils/test.utils.js';
import { EncryptionMode } from '../core/interfaces.js';
import { MockRelayHub } from '../__mocks__/mock-relay-handler.js';
import { PrivateKeySigner } from '../signer/private-key-signer.js';
import {
  buildOpenStreamPingFrame,
  buildOpenStreamStartFrame,
  type OpenStreamWriter,
} from './open-stream/index.js';
import { callToolStream } from './call-tool-stream.js';
import { NostrClientTransport } from './nostr-client-transport.js';
import { NostrServerTransport } from './nostr-server-transport.js';

function getOpenStreamWriter(extra: {
  _meta?: Record<string, unknown>;
}): OpenStreamWriter {
  const stream = (extra._meta as { stream?: OpenStreamWriter } | undefined)
    ?.stream;

  expect(stream).toBeDefined();

  return stream as OpenStreamWriter;
}

function createOpenStreamFixture(options?: {
  idleTimeoutMs?: number;
  probeTimeoutMs?: number;
  closeGracePeriodMs?: number;
}): {
  relayHub: MockRelayHub;
  server: McpServer;
  client: Client;
  serverTransport: NostrServerTransport;
  clientTransport: NostrClientTransport;
  serverPublicKey: string;
} {
  const relayHub = new MockRelayHub();
  const serverPrivateKey = bytesToHex(generateSecretKey());
  const serverPublicKey = getPublicKey(hexToBytes(serverPrivateKey));
  const clientPrivateKey = bytesToHex(generateSecretKey());

  const server = new McpServer({
    name: 'stream-server',
    version: '1.0.0',
  });

  const serverTransport = new NostrServerTransport({
    signer: new PrivateKeySigner(serverPrivateKey),
    relayHandler: relayHub.createRelayHandler(),
    encryptionMode: EncryptionMode.DISABLED,
    openStream: {
      enabled: true,
      policy: {
        idleTimeoutMs: options?.idleTimeoutMs,
        probeTimeoutMs: options?.probeTimeoutMs,
        closeGracePeriodMs: options?.closeGracePeriodMs,
      },
    },
  });

  const clientTransport = new NostrClientTransport({
    signer: new PrivateKeySigner(clientPrivateKey),
    relayHandler: relayHub.createRelayHandler(),
    serverPubkey: serverPublicKey,
    encryptionMode: EncryptionMode.DISABLED,
    openStream: {
      enabled: true,
      policy: {
        idleTimeoutMs: options?.idleTimeoutMs,
        probeTimeoutMs: options?.probeTimeoutMs,
        closeGracePeriodMs: options?.closeGracePeriodMs,
      },
    },
  });

  const client = new Client({
    name: 'stream-client',
    version: '1.0.0',
  });

  return {
    relayHub,
    server,
    client,
    serverTransport,
    clientTransport,
    serverPublicKey,
  };
}

async function bStartOutcome(
  handle: Promise<unknown>,
): Promise<'accepted' | 'failed'> {
  try {
    await handle;
    return 'accepted';
  } catch {
    return 'failed';
  }
}

function getFrameType(event: { content: string }): string | undefined {
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

function parseRelayMessage(event: { content: string }):
  | {
      method?: string;
      params?: {
        progressToken?: string;
        progress?: number;
        cvm?: {
          frameType?: string;
          nonce?: string;
          chunkIndex?: number;
          data?: string;
          lastChunkIndex?: number;
          reason?: string;
        };
      };
    }
  | undefined {
  try {
    return JSON.parse(event.content) as {
      method?: string;
      params?: {
        progressToken?: string;
        progress?: number;
        cvm?: {
          frameType?: string;
          nonce?: string;
          chunkIndex?: number;
          data?: string;
          lastChunkIndex?: number;
          reason?: string;
        };
      };
    };
  } catch {
    return undefined;
  }
}

async function cleanupOpenStreamFixture(params: {
  client: Client;
  server: McpServer;
  relayHub: MockRelayHub;
}): Promise<void> {
  await params.client.close();
  await params.server.close();
  params.relayHub.clear();
}

describe('callToolStream end-to-end', () => {
  test('streams tool output over CEP-41 with an ergonomic client API', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'subscribeToEvents',
      {
        title: 'Subscribe To Events',
        description: 'Streams mock event notifications to the caller.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`event:1:${topic}`);
        await stream.write(`event:2:${topic}`);
        await stream.close();

        return {
          content: [{ type: 'text', text: `completed:${topic}` }],
          structuredContent: {
            topic,
            streamed: true,
          },
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'subscribeToEvents',
      arguments: {
        topic: 'orders',
      },
    });

    const chunksPromise = (async (): Promise<string[]> => {
      const chunks: string[] = [];

      for await (const chunk of call.stream) {
        chunks.push(chunk.value);
      }

      return chunks;
    })();

    const [chunks, result] = await Promise.all([chunksPromise, call.result]);

    expect(chunks).toEqual(['event:1:orders', 'event:2:orders']);
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'completed:orders' }],
      structuredContent: {
        topic: 'orders',
        streamed: true,
      },
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('delays the final tool result until the stream closes', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();
    let releaseClose: (() => void) | undefined;

    server.registerTool(
      'delayedClose',
      {
        title: 'Delayed Close',
        description: 'Waits before closing the stream.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`stream:${topic}:1`);
        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
        await stream.close();

        return {
          content: [{ type: 'text', text: `done:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'delayedClose',
      arguments: {
        topic: 'orders',
      },
    });

    const firstChunk = await call.stream[Symbol.asyncIterator]().next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.value).toBe('stream:orders:1');

    let resultSettled = false;
    void call.result.then(() => {
      resultSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(resultSettled).toBe(false);

    releaseClose?.();

    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'done:orders' }],
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('rejects the stream iterator when the server aborts mid-stream', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'abortingStream',
      {
        title: 'Aborting Stream',
        description: 'Aborts after emitting one chunk.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`stream:${topic}:1`);
        await stream.abort('server aborted stream');

        return {
          content: [{ type: 'text', text: `aborted:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'abortingStream',
      arguments: {
        topic: 'orders',
      },
    });
    const closedResult = call.stream.closed.catch((error: unknown) => error);

    const iterator = call.stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.value).toBe('stream:orders:1');
    await expect(iterator.next()).rejects.toThrow('server aborted stream');
    expect(await closedResult).toBeInstanceOf(Error);

    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'aborted:orders' }],
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('keeps concurrent streams isolated by progress token', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'subscribeToEvents',
      {
        title: 'Subscribe To Events',
        description: 'Streams topic-specific events to the caller.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`${topic}:1`);
        await stream.write(`${topic}:2`);
        await stream.close();

        return {
          content: [{ type: 'text', text: `completed:${topic}` }],
          structuredContent: { topic },
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const [ordersCall, invoicesCall] = await Promise.all([
      callToolStream({
        client,
        transport: clientTransport,
        name: 'subscribeToEvents',
        arguments: { topic: 'orders' },
      }),
      callToolStream({
        client,
        transport: clientTransport,
        name: 'subscribeToEvents',
        arguments: { topic: 'invoices' },
      }),
    ]);

    const [orderChunks, invoiceChunks, orderResult, invoiceResult] =
      await Promise.all([
        (async (): Promise<string[]> => {
          const chunks: string[] = [];
          for await (const chunk of ordersCall.stream) {
            chunks.push(chunk.value);
          }
          return chunks;
        })(),
        (async (): Promise<string[]> => {
          const chunks: string[] = [];
          for await (const chunk of invoicesCall.stream) {
            chunks.push(chunk.value);
          }
          return chunks;
        })(),
        ordersCall.result,
        invoicesCall.result,
      ]);

    expect(orderChunks).toEqual(['orders:1', 'orders:2']);
    expect(invoiceChunks).toEqual(['invoices:1', 'invoices:2']);
    expect(orderResult).toMatchObject({
      content: [{ type: 'text', text: 'completed:orders' }],
      structuredContent: { topic: 'orders' },
    });
    expect(invoiceResult).toMatchObject({
      content: [{ type: 'text', text: 'completed:invoices' }],
      structuredContent: { topic: 'invoices' },
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('releases server-side pending response state after stream termination', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'subscribeToEvents',
      {
        title: 'Subscribe To Events',
        description: 'Streams mock event notifications to the caller.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`event:${topic}`);
        await stream.close();

        return {
          content: [{ type: 'text', text: `completed:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'subscribeToEvents',
      arguments: {
        topic: 'orders',
      },
    });

    await Promise.all([
      (async (): Promise<void> => {
        for await (const _chunk of call.stream) {
          // Drain the stream to completion.
        }
      })(),
      call.result,
    ]);

    await waitFor({
      produce: () => {
        const state = serverTransport.getInternalStateForTesting();
        return state.correlationStore.eventRouteCount === 0 &&
          state.openStreamReceiver.size === 0
          ? true
          : undefined;
      },
      timeoutMs: 5_000,
    });

    expect(
      serverTransport.getInternalStateForTesting().correlationStore
        .eventRouteCount,
    ).toBe(0);
    expect(
      clientTransport.getOpenStreamSession(call.progressToken),
    ).toBeUndefined();
    await expect(call.stream.closed).resolves.toBeUndefined();

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('keeps the stream alive across idle timeout ping/pong and continues delivering chunks', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture({
        idleTimeoutMs: 40,
        probeTimeoutMs: 200,
        closeGracePeriodMs: 200,
      });
    let releaseSecondChunk: (() => void) | undefined;
    let observedPongNonce: string | undefined;

    server.registerTool(
      'keepaliveStream',
      {
        title: 'Keepalive Stream',
        description: 'Waits long enough to require keepalive before resuming.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);
        const originalPong = stream.pong.bind(stream);

        stream.pong = async (nonce: string): Promise<void> => {
          observedPongNonce = nonce;
          await originalPong(nonce);
        };

        await stream.start();
        await stream.write(`stream:${topic}:1`);
        await new Promise<void>((resolve) => {
          releaseSecondChunk = resolve;
        });
        await stream.write(`stream:${topic}:2`);
        await stream.close();

        return {
          content: [{ type: 'text', text: `done:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'keepaliveStream',
      arguments: {
        topic: 'orders',
      },
    });

    const iterator = call.stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.value).toBe('stream:orders:1');

    await waitFor({
      produce: () => {
        return observedPongNonce;
      },
      timeoutMs: 5_000,
    });

    const controlFrames = relayHub
      .getEvents()
      .map((event) => getFrameType(event))
      .filter(
        (frameType): frameType is string =>
          frameType === 'ping' || frameType === 'pong',
      );

    expect(controlFrames).toContain('ping');
    expect(controlFrames).toContain('pong');

    releaseSecondChunk?.();

    const secondChunk = await iterator.next();
    expect(secondChunk.done).toBe(false);
    expect(secondChunk.value?.value).toBe('stream:orders:2');
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'done:orders' }],
    });
    await expect(call.stream.closed).resolves.toBeUndefined();

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('aborts the server-side stream when the keepalive probe is not acknowledged', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture({
        idleTimeoutMs: 40,
        probeTimeoutMs: 60,
        closeGracePeriodMs: 200,
      });
    let abortReason: string | undefined;
    let producerReleased = false;

    server.registerTool(
      'probeTimeoutStream',
      {
        title: 'Probe Timeout Stream',
        description:
          'Stays open until the receiver aborts after probe timeout.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);
        const originalPong = stream.pong.bind(stream);
        const originalAbort = stream.abort.bind(stream);

        stream.pong = async (_nonce: string): Promise<void> => {
          // Suppress pong so the receiver-side keepalive probe times out.
        };
        stream.abort = async (reason?: string): Promise<void> => {
          abortReason = reason;
          await originalAbort(reason);
        };

        await stream.start();
        await stream.write(`stream:${topic}:1`);

        await new Promise<void>((resolve) => {
          const poll = (): void => {
            if (!stream.isActive) {
              producerReleased = true;
              resolve();
              return;
            }

            setTimeout(poll, 10);
          };

          poll();
        });

        stream.pong = originalPong;

        return {
          content: [{ type: 'text', text: `probe-timeout:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'probeTimeoutStream',
      arguments: {
        topic: 'orders',
      },
    });

    const iterator = call.stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.value).toBe('stream:orders:1');
    const closedResult = call.stream.closed.catch((error: unknown) => error);

    await expect(iterator.next()).rejects.toThrow('Probe timeout');
    expect(await closedResult).toBeInstanceOf(Error);

    await waitFor({
      produce: () => {
        if (producerReleased && abortReason === 'Probe timeout') {
          return true;
        }

        return undefined;
      },
      timeoutMs: 5_000,
    });

    await waitFor({
      produce: () => {
        const state = serverTransport.getInternalStateForTesting();
        return state.correlationStore.eventRouteCount === 0 &&
          state.openStreamReceiver.size === 0
          ? true
          : undefined;
      },
      timeoutMs: 5_000,
    });

    expect(abortReason).toBe('Probe timeout');
    expect(producerReleased).toBe(true);
    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'probe-timeout:orders' }],
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('keeps streaming after an interleaved client ping and server pong', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();
    let releaseSecondChunk: (() => void) | undefined;

    server.registerTool(
      'interleavedControlStream',
      {
        title: 'Interleaved Control Stream',
        description:
          'Continues streaming after client-originated keepalive control frames.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`stream:${topic}:1`);
        await new Promise<void>((resolve) => {
          releaseSecondChunk = resolve;
        });
        await stream.write(`stream:${topic}:2`);
        await stream.close();

        return {
          content: [{ type: 'text', text: `interleaved:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'interleavedControlStream',
      arguments: {
        topic: 'orders',
      },
    });

    const iterator = call.stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.value).toBe('stream:orders:1');

    await clientTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: call.progressToken,
        progress: 1,
        cvm: {
          type: 'open-stream',
          frameType: 'ping',
          nonce: 'manual-client-ping',
        },
      },
    });

    await waitFor({
      produce: () =>
        relayHub.getEvents().find((event) => {
          const message = parseRelayMessage(event);
          return (
            message?.params?.progressToken === call.progressToken &&
            message.params?.cvm?.frameType === 'pong' &&
            message.params?.cvm?.nonce === 'manual-client-ping'
          );
        }),
      timeoutMs: 5_000,
    });

    releaseSecondChunk?.();

    const secondChunk = await iterator.next();
    expect(secondChunk.done).toBe(false);
    expect(secondChunk.value?.value).toBe('stream:orders:2');
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'interleaved:orders' }],
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('aborts the server-side stream when the client aborts the tool stream call', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();
    let abortReason: string | undefined;
    let producerReleased = false;

    server.registerTool(
      'clientAbortableStream',
      {
        title: 'Client Abortable Stream',
        description: 'Keeps the stream open until the client aborts it.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);
        const streamClosed = stream.abort.bind(stream);

        stream.abort = async (reason?: string): Promise<void> => {
          abortReason = reason;
          await streamClosed(reason);
        };

        await stream.start();
        await stream.write(`stream:${topic}:1`);

        await new Promise<void>((resolve) => {
          const poll = (): void => {
            if (!stream.isActive) {
              producerReleased = true;
              resolve();
              return;
            }

            setTimeout(poll, 10);
          };

          poll();
        });

        return {
          content: [{ type: 'text', text: `client-aborted:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'clientAbortableStream',
      arguments: {
        topic: 'orders',
      },
    });

    const iterator = call.stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.value).toBe('stream:orders:1');

    const closedResult = call.stream.closed.catch((error: unknown) => error);
    await call.abort('client cancelled stream');

    await expect(iterator.next()).rejects.toThrow('client cancelled stream');
    expect(await closedResult).toBeInstanceOf(Error);

    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'client-aborted:orders' }],
    });

    await waitFor({
      produce: () => {
        if (producerReleased && abortReason === 'client cancelled stream') {
          return true;
        }

        return undefined;
      },
      timeoutMs: 5_000,
    });

    await waitFor({
      produce: () => {
        const state = serverTransport.getInternalStateForTesting();
        return state.correlationStore.eventRouteCount === 0 &&
          state.openStreamReceiver.size === 0
          ? true
          : undefined;
      },
      timeoutMs: 5_000,
    });

    expect(abortReason).toBe('client cancelled stream');
    expect(producerReleased).toBe(true);
    expect(
      serverTransport.getInternalStateForTesting().correlationStore
        .eventRouteCount,
    ).toBe(0);
    expect(
      clientTransport.getOpenStreamSession(call.progressToken),
    ).toBeUndefined();

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('keeps concurrent streams isolated when one aborts and the other closes', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'mixedTerminalStreams',
      {
        title: 'Mixed Terminal Streams',
        description: 'Aborts one stream and closes the other.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`${topic}:1`);

        if (topic === 'orders') {
          await stream.abort('orders aborted');

          return {
            content: [{ type: 'text', text: `aborted:${topic}` }],
          };
        }

        await stream.write(`${topic}:2`);
        await stream.close();

        return {
          content: [{ type: 'text', text: `completed:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const [ordersCall, invoicesCall] = await Promise.all([
      callToolStream({
        client,
        transport: clientTransport,
        name: 'mixedTerminalStreams',
        arguments: { topic: 'orders' },
      }),
      callToolStream({
        client,
        transport: clientTransport,
        name: 'mixedTerminalStreams',
        arguments: { topic: 'invoices' },
      }),
    ]);

    const ordersClosed = ordersCall.stream.closed.catch(
      (error: unknown) => error,
    );
    const ordersIterator = ordersCall.stream[Symbol.asyncIterator]();
    const orderFirstChunk = await ordersIterator.next();
    expect(orderFirstChunk.done).toBe(false);
    expect(orderFirstChunk.value?.value).toBe('orders:1');
    await expect(ordersIterator.next()).rejects.toThrow('orders aborted');
    expect(await ordersClosed).toBeInstanceOf(Error);

    const invoiceChunks: string[] = [];
    for await (const chunk of invoicesCall.stream) {
      invoiceChunks.push(chunk.value);
    }

    expect(invoiceChunks).toEqual(['invoices:1', 'invoices:2']);
    await expect(invoicesCall.stream.closed).resolves.toBeUndefined();
    await expect(ordersCall.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'aborted:orders' }],
    });
    await expect(invoicesCall.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'completed:invoices' }],
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('emits an accept frame for client-to-server CEP-41 bootstrap', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'bootstrapOnly',
      {
        title: 'Bootstrap Only',
        description: 'Stays pending while bootstrap frames are negotiated.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        void getOpenStreamWriter(extra);

        await new Promise<void>(() => undefined);

        return {
          content: [{ type: 'text', text: `unused:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const progressToken = 'client-origin-stream';
    void client.callTool({
      name: 'bootstrapOnly',
      arguments: {
        topic: 'orders',
        _meta: {
          progressToken,
        },
      },
    });

    await clientTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: buildOpenStreamStartFrame({
        progressToken,
        progress: 1,
      }),
    });

    const acceptEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find((event) => getFrameType(event) === 'accept'),
      timeoutMs: 5_000,
    });

    expect(acceptEvent).toBeDefined();
    expect(JSON.parse(acceptEvent.content)).toMatchObject({
      method: 'notifications/progress',
      params: {
        progressToken,
        // CEP-41 per-sender progress: accept is the server's first outbound
        // frame on its own sequence, independent of the client's start value.
        progress: 1,
        cvm: {
          type: 'open-stream',
          frameType: 'accept',
        },
      },
    });

    // A keepalive ping on the bootstrap token must be answered even though
    // the token has no correlation route: the session resolves the peer from
    // the frame's signer, and the pong joins the server's shared sequence.
    await clientTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: buildOpenStreamPingFrame({
        progressToken,
        progress: 2,
        nonce: 'bootstrap-ping',
      }),
    });

    const pongEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find((event) => {
          const message = parseRelayMessage(event);
          return (
            message?.params?.cvm?.frameType === 'pong' &&
            message.params.cvm.nonce === 'bootstrap-ping'
          );
        }),
      timeoutMs: 5_000,
    });
    expect(parseRelayMessage(pongEvent)?.params?.progress).toBe(2);

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('keeps a client-started stream alive across bootstrap, ping and pong on one per-sender sequence', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture({ idleTimeoutMs: 40, probeTimeoutMs: 5_000 });

    server.registerTool(
      'clientStartedEcho',
      {
        title: 'Client Started Echo',
        description: 'Stays pending while the client streams.',
        inputSchema: { topic: z.string() },
      },
      async () => {
        await new Promise<void>(() => undefined);
        return { content: [{ type: 'text', text: 'unused' }] };
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Routed token via the real progress-token machinery.
    void client
      .callTool(
        { name: 'clientStartedEcho', arguments: { topic: 'orders' } },
        undefined,
        { onprogress: () => undefined, resetTimeoutOnProgress: false },
      )
      .catch(() => undefined);
    const requestEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find(
          (event) => parseRelayMessage(event)?.method === 'tools/call',
        ),
      timeoutMs: 5_000,
    });
    const progressToken = String(
      (
        parseRelayMessage(requestEvent)?.params as
          | { _meta?: { progressToken?: unknown } }
          | undefined
      )?._meta?.progressToken,
    );
    expect(progressToken.length).toBeGreaterThan(0);

    // Client-started bootstrap: start@1 on the client's own sequence, and a
    // session that can receive the server's accept and control frames.
    const { session } = await clientTransport.startOpenStream(progressToken);
    expect(session.isActive).toBe(true);

    const acceptEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find(
          (event) =>
            getFrameType(event) === 'accept' &&
            parseRelayMessage(event)?.params?.progressToken === progressToken,
        ),
      timeoutMs: 5_000,
    });
    expect(parseRelayMessage(acceptEvent)?.params?.progress).toBe(1);
    const serverPublicKey = acceptEvent.pubkey;

    // Keepalive idles on both sessions with this fixture policy; whichever
    // side probes first, each side stays on its own shared per-token
    // sequence, so the server frames stay monotonic after accept@1.
    await waitFor({
      produce: () =>
        relayHub.getEvents().find((event) => {
          const message = parseRelayMessage(event);
          return (
            message?.params?.cvm?.frameType === 'pong' &&
            message.params.progressToken === progressToken
          );
        }),
      timeoutMs: 5_000,
    });

    const serverFrames = relayHub
      .getEvents()
      .filter(
        (event) =>
          event.pubkey === serverPublicKey &&
          parseRelayMessage(event)?.params?.progressToken === progressToken,
      )
      .map((event) => ({
        frameType: getFrameType(event),
        progress: parseRelayMessage(event)?.params?.progress,
      }));

    // The server's own outbound sequence stays strictly monotonic across
    // bootstrap accept and keepalive traffic (accept@1, then ping/pong at 2+).
    expect(serverFrames[0]).toEqual({ frameType: 'accept', progress: 1 });
    for (let i = 1; i < serverFrames.length; i++) {
      expect(serverFrames[i]!.progress!).toBeGreaterThan(
        serverFrames[i - 1]!.progress!,
      );
    }
    // The keepalive round-trip kept the client session alive.
    expect(session.isActive).toBe(true);
    expect(
      relayHub.getEvents().some((event) => getFrameType(event) === 'abort'),
    ).toBe(false);

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('streams client payload to a tool over a client-started stream end to end', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture({ idleTimeoutMs: 40, probeTimeoutMs: 5_000 });

    server.registerTool(
      'ingestStream',
      {
        title: 'Ingest Stream',
        description: 'Consumes streamed input.',
        inputSchema: { topic: z.string() },
      },
      async (_args, extra) => {
        const inputStream = (
          extra._meta as {
            inputStream?: AsyncIterable<{ value: string; chunkIndex: number }>;
          } | undefined
        )?.inputStream;
        expect(inputStream).toBeDefined();

        let text = '';
        for await (const chunk of inputStream!) {
          text += chunk.value;
        }

        return { content: [{ type: 'text', text: `got:${text}` }] };
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const pending = client.callTool(
      { name: 'ingestStream', arguments: { topic: 'orders' } },
      undefined,
      { onprogress: () => undefined, resetTimeoutOnProgress: false },
    );
    void pending.catch(() => undefined);

    const requestEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find(
          (event) => parseRelayMessage(event)?.method === 'tools/call',
        ),
      timeoutMs: 5_000,
    });
    const progressToken = String(
      (
        parseRelayMessage(requestEvent)?.params as
          | { _meta?: { progressToken?: unknown } }
          | undefined
      )?._meta?.progressToken,
    );
    const clientPublicKey = requestEvent.pubkey;

    // Bootstrap: start@1 on the client sequence, gated on the server's
    // accept before any chunk frame (CEP-41).
    const { session, writer } =
      await clientTransport.startOpenStream(progressToken);
    expect(session.isActive).toBe(true);

    await writer.write('hello ');
    await writer.write('world');
    await writer.close();

    const result = (await pending) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe('got:hello world');

    // The client's own outbound sequence stays strictly monotonic from
    // start@1 across chunks, interleaved keepalive and the final close.
    const clientFrames = relayHub
      .getEvents()
      .filter(
        (event) =>
          event.pubkey === clientPublicKey &&
          parseRelayMessage(event)?.params?.progressToken === progressToken,
      )
      .map((event) => ({
        frameType: getFrameType(event),
        progress: parseRelayMessage(event)?.params?.progress,
      }));
    expect(clientFrames[0]).toEqual({ frameType: 'start', progress: 1 });
    for (let i = 1; i < clientFrames.length; i++) {
      expect(clientFrames[i]!.progress!).toBeGreaterThan(
        clientFrames[i - 1]!.progress!,
      );
    }
    expect(clientFrames.some((f) => f.frameType === 'close')).toBe(true);
    expect(session.isActive).toBe(false);

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('keeps a client-started stream alive across session keepalive probe cycles', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture({ idleTimeoutMs: 40, probeTimeoutMs: 150 });

    server.registerTool(
      'ingestStream',
      {
        title: 'Ingest Stream',
        description: 'Consumes streamed input.',
        inputSchema: { topic: z.string() },
      },
      async (_args, extra) => {
        const inputStream = (
          extra._meta as {
            inputStream?: AsyncIterable<{ value: string; chunkIndex: number }>;
          } | undefined
        )?.inputStream;

        let text = '';
        for await (const chunk of inputStream ?? []) {
          text += chunk.value;
        }

        return { content: [{ type: 'text', text: `got:${text}` }] };
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const pending = client.callTool(
      { name: 'ingestStream', arguments: { topic: 'orders' } },
      undefined,
      { onprogress: () => undefined, resetTimeoutOnProgress: false },
    );
    void pending.catch(() => undefined);

    const requestEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find(
          (event) => parseRelayMessage(event)?.method === 'tools/call',
        ),
      timeoutMs: 5_000,
    });
    const progressToken = String(
      (
        parseRelayMessage(requestEvent)?.params as
          | { _meta?: { progressToken?: unknown } }
          | undefined
      )?._meta?.progressToken,
    );
    const clientPublicKey = requestEvent.pubkey;

    const { session, writer } =
      await clientTransport.startOpenStream(progressToken);
    await writer.write('hello ');

    // Hold the stream open across several idle -> ping -> pong probe
    // cycles. The session's keepalive pings are answered by the client
    // session; those pongs must reach the receiver session (not the
    // request's reserved output writer) or the stream dies on probe
    // timeout.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(session.isActive).toBe(true);

    const serverPings = relayHub.getEvents().filter(
      (event) =>
        event.pubkey !== clientPublicKey &&
        parseRelayMessage(event)?.params?.progressToken === progressToken &&
        getFrameType(event) === 'ping',
    );
    expect(serverPings.length).toBeGreaterThan(0);

    await writer.write('world');
    await writer.close();

    const result = (await pending) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe('got:hello world');

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('gives concurrent same-token clients independent client-started streams', async () => {
    const {
      relayHub,
      server,
      client,
      serverTransport,
      clientTransport,
      serverPublicKey,
    } = createOpenStreamFixture({ idleTimeoutMs: 5_000, probeTimeoutMs: 5_000 });

    server.registerTool(
      'ingestStream',
      {
        title: 'Ingest Stream',
        description: 'Consumes streamed input.',
        inputSchema: { topic: z.string() },
      },
      async (_args, extra) => {
        const inputStream = (
          extra._meta as {
            inputStream?: AsyncIterable<{ value: string; chunkIndex: number }>;
          } | undefined
        )?.inputStream;

        let text = '';
        for await (const chunk of inputStream ?? []) {
          text += chunk.value;
        }

        return { content: [{ type: 'text', text: `got:${text}` }] };
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const pending = client.callTool(
      { name: 'ingestStream', arguments: { topic: 'orders' } },
      undefined,
      { onprogress: () => undefined, resetTimeoutOnProgress: false },
    );
    void pending.catch(() => undefined);

    const requestEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find(
          (event) => parseRelayMessage(event)?.method === 'tools/call',
        ),
      timeoutMs: 5_000,
    });
    const progressToken = String(
      (
        parseRelayMessage(requestEvent)?.params as
          | { _meta?: { progressToken?: unknown } }
          | undefined
      )?._meta?.progressToken,
    );

    // Client A holds an active upload on the token.
    const { session: ownerSession, writer } =
      await clientTransport.startOpenStream(progressToken);
    await writer.write('A-');

    // Client B legitimately reuses the same client-local token concurrently:
    // it must get an INDEPENDENT stream (own session, own accept), never
    // attaching to or corrupting A's stream.
    const clientBTransport = new NostrClientTransport({
      signer: new PrivateKeySigner(bytesToHex(generateSecretKey())),
      relayHandler: relayHub.createRelayHandler(),
      serverPubkey: serverPublicKey,
      encryptionMode: EncryptionMode.DISABLED,
      openStream: { enabled: true },
    });
    const clientB = new Client({ name: 'stream-client-b', version: '1.0.0' });
    await clientB.connect(clientBTransport);

    const bHandle = clientBTransport.startOpenStream(progressToken);
    const bOutcome = await Promise.race([
      bStartOutcome(bHandle),
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 2_000),
      ),
    ]);
    expect(bOutcome).toBe('accepted');
    expect(ownerSession.isActive).toBe(true);

    const { session: sessionB, writer: writerB } = await bHandle;
    await writerB.write('B-only');

    // Hold both streams open across keepalive cycles: A's pongs must be
    // routed back to A's session even though B now shares the token.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(ownerSession.isActive).toBe(true);
    expect(sessionB.isActive).toBe(true);

    // A's stream completes with A's payload only; B's closes independently.
    await writer.write('data');
    await writer.close();
    const result = (await pending) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe('got:A-data');

    await writerB.close();
    await sessionB.closed;

    await clientB.close();
    await clientBTransport.close();
    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('unblocks the tool input iterator when the client aborts an input stream', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture({ idleTimeoutMs: 5_000, probeTimeoutMs: 5_000 });

    server.registerTool(
      'ingestStream',
      {
        title: 'Ingest Stream',
        description: 'Consumes streamed input.',
        inputSchema: { topic: z.string() },
      },
      async (_args, extra) => {
        const inputStream = (
          extra._meta as {
            inputStream?: AsyncIterable<{ value: string; chunkIndex: number }>;
          } | undefined
        )?.inputStream;

        let text = '';
        try {
          for await (const chunk of inputStream ?? []) {
            text += chunk.value;
          }
          return {
            content: [{ type: 'text', text: `got:${text}` }],
          };
        } catch {
          // The input stream aborted mid-transfer; the tool must observe it
          // promptly instead of blocking until keepalive timeout.
          return {
            content: [{ type: 'text', text: `aborted:${text}` }],
          };
        }
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const pending = client.callTool(
      { name: 'ingestStream', arguments: { topic: 'orders' } },
      undefined,
      { onprogress: () => undefined, resetTimeoutOnProgress: false },
    );

    const requestEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find(
          (event) => parseRelayMessage(event)?.method === 'tools/call',
        ),
      timeoutMs: 5_000,
    });
    const progressToken = String(
      (
        parseRelayMessage(requestEvent)?.params as
          | { _meta?: { progressToken?: unknown } }
          | undefined
      )?._meta?.progressToken,
    );

    const { session, writer } =
      await clientTransport.startOpenStream(progressToken);
    await writer.write('part');
    await writer.abort('client done');

    const result = (await pending) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0]?.text).toBe('aborted:part');
    expect(session.isActive).toBe(false);

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('terminates the client session without a second abort when the payload writer aborts', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'bootstrapAbortSink',
      {
        title: 'Bootstrap Abort Sink',
        description: 'Stays pending.',
        inputSchema: { topic: z.string() },
      },
      async () => {
        await new Promise<void>(() => undefined);
        return { content: [{ type: 'text', text: 'unused' }] };
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const pending = client.callTool(
      { name: 'bootstrapAbortSink', arguments: { topic: 'orders' } },
      undefined,
      { onprogress: () => undefined, resetTimeoutOnProgress: false },
    );
    void pending.catch(() => undefined);

    const requestEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find(
          (event) => parseRelayMessage(event)?.method === 'tools/call',
        ),
      timeoutMs: 5_000,
    });
    const progressToken = String(
      (
        parseRelayMessage(requestEvent)?.params as
          | { _meta?: { progressToken?: unknown } }
          | undefined
      )?._meta?.progressToken,
    );
    const clientPublicKey = requestEvent.pubkey;

    const { session, writer } =
      await clientTransport.startOpenStream(progressToken);
    await writer.abort('client stopped');

    // Exactly one abort frame from the client, and the session is gone
    // locally (registry cleanup ran through the terminate lifecycle).
    const clientAborts = relayHub.getEvents().filter((event) => {
      const message = parseRelayMessage(event);
      return (
        event.pubkey === clientPublicKey &&
        message?.params?.progressToken === progressToken &&
        message.params.cvm?.frameType === 'abort'
      );
    });
    expect(clientAborts.length).toBe(1);
    expect(session.isActive).toBe(false);

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('publishes abort when a duplicate start fails the stream server-side', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();

    server.registerTool(
      'bootstrapHang',
      {
        title: 'Bootstrap Hang',
        description: 'Stays pending.',
        inputSchema: { topic: z.string() },
      },
      async () => {
        await new Promise<void>(() => undefined);
        return { content: [{ type: 'text', text: 'unused' }] };
      },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const progressToken = 'duplicate-start-token';
    void client
      .callTool({
        name: 'bootstrapHang',
        arguments: { topic: 'orders', _meta: { progressToken } },
      })
      .catch(() => undefined);

    await clientTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: buildOpenStreamStartFrame({ progressToken, progress: 1 }),
    });
    const acceptEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find((event) => getFrameType(event) === 'accept'),
      timeoutMs: 5_000,
    });

    // Second start for an active token: the stream MUST fail (CEP-41) and
    // the failure must reach the peer as abort, not die silently.
    await clientTransport.send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: buildOpenStreamStartFrame({ progressToken, progress: 2 }),
    });

    const abortEvent = await waitFor({
      produce: () =>
        relayHub.getEvents().find((event) => getFrameType(event) === 'abort'),
      timeoutMs: 5_000,
    });
    expect(abortEvent.pubkey).toBe(acceptEvent.pubkey);
    expect(parseRelayMessage(abortEvent)?.params).toMatchObject({
      progressToken,
      progress: 2,
      cvm: {
        type: 'open-stream',
        frameType: 'abort',
      },
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);

  test('defers the final JSON-RPC response until the stream closes', async () => {
    const { relayHub, server, client, serverTransport, clientTransport } =
      createOpenStreamFixture();
    let releaseClose: (() => void) | undefined;

    server.registerTool(
      'deferredResponseStream',
      {
        title: 'Deferred Response Stream',
        description: 'Keeps the stream open until explicitly released.',
        inputSchema: {
          topic: z.string(),
        },
      },
      async ({ topic }, extra) => {
        const stream = getOpenStreamWriter(extra);

        await stream.start();
        await stream.write(`stream:${topic}:1`);

        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });

        await stream.close();

        return {
          content: [{ type: 'text', text: `deferred:${topic}` }],
        };
      },
    );

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = await callToolStream({
      client,
      transport: clientTransport,
      name: 'deferredResponseStream',
      arguments: {
        topic: 'orders',
      },
    });

    const iterator = call.stream[Symbol.asyncIterator]();
    const firstChunk = await iterator.next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value?.value).toBe('stream:orders:1');

    let resultSettled = false;
    void call.result.finally(() => {
      resultSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resultSettled).toBe(false);

    releaseClose?.();

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(call.result).resolves.toMatchObject({
      content: [{ type: 'text', text: 'deferred:orders' }],
    });

    await cleanupOpenStreamFixture({ client, server, relayHub });
  }, 15_000);
});
