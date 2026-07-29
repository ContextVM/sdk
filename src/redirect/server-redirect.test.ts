import { describe, expect, test, mock } from 'bun:test';
import type { JSONRPCRequest, JSONRPCNotification } from '@contextvm/mcp-sdk/types.js';
import { createRedirectMiddleware } from './server-redirect.js';
import { withServerRedirect } from './server-transport-redirect.js';
import { REDIRECT_ERROR_CODE } from '../payments/constants.js';
import type { ServerRedirectConfig } from './types.js';

describe('createRedirectMiddleware', () => {
  const dummyCtx = {
    clientPubkey: 'a'.repeat(64),
  };

  test('emits -32044 and halts when resolveRedirect returns a target', async () => {
    let sentResponse: unknown = null;
    let forwarded = false;

    const config: ServerRedirectConfig = {
      resolveRedirect: async () => ({
        target: 'b'.repeat(64),
        relays: ['wss://relay.example.com'],
        instructions: 'Please reconnect to backend B',
        _meta: { region: 'us-east' },
      }),
    };

    const middleware = createRedirectMiddleware({
      config,
      sendResponse: async (clientPubkey, res) => {
        sentResponse = { clientPubkey, res };
      },
    });

    const req: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'tools/call',
      params: { name: 'echo' },
    };

    await middleware(req, dummyCtx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(false);
    expect(sentResponse).toEqual({
      clientPubkey: dummyCtx.clientPubkey,
      res: {
        jsonrpc: '2.0',
        id: 'req-1',
        error: {
          code: REDIRECT_ERROR_CODE,
          message: 'Redirect',
          data: {
            target: 'b'.repeat(64),
            relays: ['wss://relay.example.com'],
            instructions: 'Please reconnect to backend B',
            _meta: { region: 'us-east' },
          },
        },
      },
    });
  });

  test('forwards normally without emitting error when resolveRedirect returns null', async () => {
    let sentResponse: unknown = null;
    let forwarded = false;

    const config: ServerRedirectConfig = {
      resolveRedirect: async () => null,
    };

    const middleware = createRedirectMiddleware({
      config,
      sendResponse: async (clientPubkey, res) => {
        sentResponse = { clientPubkey, res };
      },
    });

    const req: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'tools/list',
    };

    await middleware(req, dummyCtx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(true);
    expect(sentResponse).toBeNull();
  });

  test('forwards normally (fail-open) when resolveRedirect throws an error', async () => {
    let sentResponse: unknown = null;
    let forwarded = false;

    const config: ServerRedirectConfig = {
      resolveRedirect: async () => {
        throw new Error('Database connection failed');
      },
    };

    const middleware = createRedirectMiddleware({
      config,
      sendResponse: async (clientPubkey, res) => {
        sentResponse = { clientPubkey, res };
      },
    });

    const req: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'tools/call',
    };

    await middleware(req, dummyCtx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(true);
    expect(sentResponse).toBeNull();
  });

  test('passes through notifications without calling resolveRedirect', async () => {
    const resolveMock = mock(async () => ({ target: 'b'.repeat(64) }));
    let forwarded = false;

    const middleware = createRedirectMiddleware({
      config: { resolveRedirect: resolveMock },
      sendResponse: async () => {},
    });

    const notif: JSONRPCNotification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    };

    await middleware(notif, dummyCtx, async () => {
      forwarded = true;
    });

    expect(forwarded).toBe(true);
    expect(resolveMock).toHaveBeenCalledTimes(0);
  });

  test('applies default instructions and _meta from config when callback result does not override them', async () => {
    let sentData: unknown = null;

    const middleware = createRedirectMiddleware({
      config: {
        instructions: 'Default instructions',
        _meta: { tier: 'free' },
        resolveRedirect: async () => ({
          target: 'c'.repeat(64),
        }),
      },
      sendResponse: async (_, res) => {
        sentData = res.error.data;
      },
    });

    await middleware(
      { jsonrpc: '2.0', id: 1, method: 'tools/call' },
      dummyCtx,
      async () => {},
    );

    expect(sentData).toEqual({
      target: 'c'.repeat(64),
      instructions: 'Default instructions',
      _meta: { tier: 'free' },
    });
  });

  test('per-request callback instructions and _meta override and merge with config defaults', async () => {
    let sentData: unknown = null;

    const middleware = createRedirectMiddleware({
      config: {
        instructions: 'Default instructions',
        _meta: { tier: 'free', region: 'us' },
        resolveRedirect: async () => ({
          target: 'd'.repeat(64),
          instructions: 'Override instructions',
          _meta: { tier: 'pro', custom: true },
        }),
      },
      sendResponse: async (_, res) => {
        sentData = res.error.data;
      },
    });

    await middleware(
      { jsonrpc: '2.0', id: 2, method: 'tools/call' },
      dummyCtx,
      async () => {},
    );

    expect(sentData).toEqual({
      target: 'd'.repeat(64),
      instructions: 'Override instructions',
      _meta: { tier: 'pro', region: 'us', custom: true },
    });
  });
});

describe('withServerRedirect', () => {
  test('registers inbound middleware on the transport', () => {
    const addedMiddlewares: unknown[] = [];
    const fakeTransport = {
      addInboundMiddleware: (mw: unknown) => addedMiddlewares.push(mw),
      sendTargetedResponse: async () => {},
    } as unknown as import('../transport/nostr-server-transport.js').NostrServerTransport;

    withServerRedirect(fakeTransport, { resolveRedirect: async () => null });
    expect(addedMiddlewares.length).toBe(1);
    expect(typeof addedMiddlewares[0]).toBe('function');
  });
});
