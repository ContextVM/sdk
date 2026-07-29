import { describe, expect, test } from 'bun:test';
import type { JSONRPCMessage, JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import { withClientRedirect } from './client-redirect.js';
import { REDIRECT_ERROR_CODE } from '../payments/constants.js';

class FakeTransport implements Transport {
  public onmessage?: (msg: JSONRPCMessage) => void;
  public onmessageWithContext?: (
    msg: JSONRPCMessage,
    ctx: { eventId: string },
  ) => void;
  public onerror?: (err: Error) => void;
  public onclose?: () => void;
  public sentMessages: JSONRPCMessage[] = [];
  public started = false;
  public closed = false;
  public readonly serverPubkey: string;

  constructor(serverPubkey = 'a'.repeat(64)) {
    this.serverPubkey = serverPubkey;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    this.sentMessages.push(msg);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  emit(msg: JSONRPCMessage, ctx = { eventId: 'evt-1' }): void {
    if (this.onmessageWithContext) {
      this.onmessageWithContext(msg, ctx);
    } else {
      this.onmessage?.(msg);
    }
  }
}

const dummySigner = '1'.repeat(64);

describe('withClientRedirect', () => {
  test('passes normal responses through unchanged', async () => {
    const baseTransport = new FakeTransport('a'.repeat(64));
    const wrapped = withClientRedirect(baseTransport, { signer: dummySigner });

    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (msg) => received.push(msg);
    await wrapped.start();

    const req: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    };
    await wrapped.send(req);

    baseTransport.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [] },
    } as unknown as JSONRPCMessage);

    expect(received.length).toBe(1);
    expect((received[0] as { result?: unknown }).result).toEqual({ tools: [] });
  });

  test('follows -32044 redirect: starts new transport, closes old, and re-issues request', async () => {
    const baseTransport = new FakeTransport('a'.repeat(64));
    const newTransportsCreated: Transport[] = [];
    let onRedirectCalled = false;
    let redirectHop = 0;

    const targetPubkey = 'b'.repeat(64);

    const wrapped = withClientRedirect(
      baseTransport,
      {
        signer: dummySigner,
        wrapTransport: () => {
          const next = new FakeTransport(targetPubkey);
          newTransportsCreated.push(next);
          return next;
        },
      },
      {
        onRedirect: (data, hop) => {
          onRedirectCalled = true;
          redirectHop = hop;
          expect(data.target).toBe(targetPubkey);
        },
      },
    );

    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (msg) => received.push(msg);
    await wrapped.start();

    const req: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'req-100',
      method: 'tools/call',
      params: { name: 'test' },
    };
    await wrapped.send(req);
    expect(baseTransport.sentMessages.length).toBe(1);

    // Emit -32044 redirect from server A
    baseTransport.emit({
      jsonrpc: '2.0',
      id: 'req-100',
      error: {
        code: REDIRECT_ERROR_CODE,
        message: 'Redirect',
        data: { target: targetPubkey, relays: ['wss://relay.example.com'] },
      },
    } as unknown as JSONRPCMessage);

    // Allow async transition to settle
    await new Promise((r) => setTimeout(r, 30));

    expect(onRedirectCalled).toBe(true);
    expect(redirectHop).toBe(1);
    expect(baseTransport.closed).toBe(true);
    expect(newTransportsCreated.length).toBe(1);

    const newTransport = newTransportsCreated[0] as FakeTransport;
    expect(newTransport.serverPubkey).toBe(targetPubkey);

    // Check that the original request was re-issued over the new transport
    expect(newTransport.sentMessages.length).toBe(1);
    expect(newTransport.sentMessages[0]).toEqual(req);
  });

  test('surfaces error without redirecting if target pubkey is invalid', async () => {
    const baseTransport = new FakeTransport('a'.repeat(64));
    const wrapped = withClientRedirect(baseTransport, { signer: dummySigner });

    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (msg) => received.push(msg);
    await wrapped.start();

    await wrapped.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
    });

    baseTransport.emit({
      jsonrpc: '2.0',
      id: 2,
      error: {
        code: REDIRECT_ERROR_CODE,
        message: 'Redirect',
        data: { target: 'invalid-hex' },
      },
    } as unknown as JSONRPCMessage);

    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(1);
    expect((received[0] as { error?: { code: number } }).error?.code).toBe(
      REDIRECT_ERROR_CODE,
    );
    expect(baseTransport.closed).toBe(false);
  });

  test('redirectPolicy returning false rejects redirect and surfaces -32044 error', async () => {
    const baseTransport = new FakeTransport('a'.repeat(64));
    const wrapped = withClientRedirect(
      baseTransport,
      { signer: dummySigner },
      {
        redirectPolicy: async (data) => data.target !== 'c'.repeat(64),
      },
    );

    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (msg) => received.push(msg);
    await wrapped.start();

    await wrapped.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
    });

    baseTransport.emit({
      jsonrpc: '2.0',
      id: 3,
      error: {
        code: REDIRECT_ERROR_CODE,
        message: 'Redirect',
        data: { target: 'c'.repeat(64) },
      },
    } as unknown as JSONRPCMessage);

    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(1);
    expect((received[0] as { error?: { code: number } }).error?.code).toBe(
      REDIRECT_ERROR_CODE,
    );
    expect(baseTransport.closed).toBe(false);
  });

  test('exceeding maxRedirects stops redirect loop and surfaces error', async () => {
    const baseTransport = new FakeTransport('a'.repeat(64));
    let nextTransport: FakeTransport | undefined;

    const wrapped = withClientRedirect(
      baseTransport,
      {
        signer: dummySigner,
        wrapTransport: () => {
          nextTransport = new FakeTransport('d'.repeat(64));
          return nextTransport;
        },
      },
      { maxRedirects: 1 },
    );

    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (msg) => received.push(msg);
    await wrapped.start();

    const req: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
    };
    await wrapped.send(req);

    // Hop 1: allowed (maxRedirects is 1)
    baseTransport.emit({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: REDIRECT_ERROR_CODE,
        message: 'Redirect',
        data: { target: 'd'.repeat(64) },
      },
    } as unknown as JSONRPCMessage);

    await new Promise((r) => setTimeout(r, 30));
    expect(baseTransport.closed).toBe(true);
    expect(nextTransport).toBeDefined();

    // Hop 2: emitted from nextTransport, exceeding maxRedirects = 1
    nextTransport!.emit({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: REDIRECT_ERROR_CODE,
        message: 'Redirect',
        data: { target: 'e'.repeat(64) },
      },
    } as unknown as JSONRPCMessage);

    await new Promise((r) => setTimeout(r, 20));
    expect(received.length).toBe(1);
    expect((received[0] as { error?: { code: number } }).error?.code).toBe(
      REDIRECT_ERROR_CODE,
    );
    expect(nextTransport!.closed).toBe(false);
  });

  test('forwards messages via onmessageWithContext when consumer attaches it', async () => {
    const baseTransport = new FakeTransport('a'.repeat(64));
    const wrapped = withClientRedirect(baseTransport, { signer: dummySigner });

    const receivedWithCtx: Array<{ msg: JSONRPCMessage; ctx: unknown }> = [];
    (wrapped as { onmessageWithContext?: unknown }).onmessageWithContext = (
      msg: JSONRPCMessage,
      ctx: unknown,
    ) => receivedWithCtx.push({ msg, ctx });
    await wrapped.start();

    baseTransport.emit(
      {
        jsonrpc: '2.0',
        id: 5,
        result: { ok: true },
      } as unknown as JSONRPCMessage,
      { eventId: 'evt-5' },
    );

    expect(receivedWithCtx.length).toBe(1);
    expect(receivedWithCtx[0].ctx).toEqual({ eventId: 'evt-5' });
  });
});
