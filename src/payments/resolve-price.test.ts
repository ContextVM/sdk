import { describe, expect, test } from 'bun:test';
import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServerPaymentsMiddleware } from './server-payments.js';

describe('resolvePrice (server payments)', () => {
  test('uses resolvePrice quote amount + merges meta into payment_required._meta (quote wins)', async () => {
    const processor = {
      pmi: 'fake',
      async createPaymentRequired(params: {
        amount: number;
        description?: string;
        requestEventId: string;
        clientPubkey: string;
      }) {
        return {
          amount: params.amount,
          pay_req: 'pay_req',
          description: params.description,
          pmi: 'fake',
          ttl: 300,
          _meta: { source: 'processor', overlap: 'processor' },
        };
      },
      async verifyPayment() {
        return { _meta: { ok: true } };
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
        description: 'listed',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    const sent: Array<{ notification: unknown; requestEventId: string }> = [];
    const sender = {
      async sendNotification(
        _clientPubkey: string,
        notification: unknown,
        requestEventId: string,
      ): Promise<void> {
        sent.push({ notification, requestEventId });
      },
    };

    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
        resolvePrice: async ({
          capability,
          request,
          clientPubkey,
          requestEventId,
        }) => {
          expect(clientPubkey).toBe('test-client');
          expect(capability.name).toBe('add');
          expect(request.method).toBe('tools/call');
          expect(requestEventId).toBe('event-id');
          return {
            amount: 123,
            description: 'quoted',
            meta: { source: 'quote', overlap: 'quote' },
          };
        },
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'event-id',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    const forward = async () => {
      // no-op
    };

    await mw(message, ctx, forward);

    const paymentRequired = sent.find(
      (x) =>
        typeof x.notification === 'object' &&
        x.notification !== null &&
        (x.notification as { method?: string }).method ===
          'notifications/payment_required',
    );
    expect(paymentRequired).toBeDefined();

    const pr = paymentRequired!.notification as {
      params: {
        amount: number;
        description?: string;
        _meta?: Record<string, unknown>;
      };
    };
    expect(pr.params.amount).toBe(123);
    expect(pr.params.description).toBe('quoted');
    expect(pr.params._meta).toEqual({
      source: 'quote',
      overlap: 'quote',
    });
  });

  test('does not add _meta when neither processor nor quote provide meta', async () => {
    const processor = {
      pmi: 'fake',
      async createPaymentRequired(params: {
        amount: number;
        description?: string;
        requestEventId: string;
        clientPubkey: string;
      }) {
        return {
          amount: params.amount,
          pay_req: 'pay_req',
          description: params.description,
          pmi: 'fake',
        };
      },
      async verifyPayment() {
        return {};
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    let paymentRequired: unknown;
    const sender = {
      async sendNotification(
        _clientPubkey: string,
        notification: unknown,
      ): Promise<void> {
        if (
          typeof notification === 'object' &&
          notification !== null &&
          (notification as { method?: string }).method ===
            'notifications/payment_required'
        ) {
          paymentRequired = notification;
        }
      },
    };

    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
        resolvePrice: async () => ({ amount: 2 }),
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'event-id',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    await mw(message, ctx, async () => {
      // no-op
    });

    expect(paymentRequired).toBeDefined();
    const pr = paymentRequired as { params: { _meta?: unknown } };
    expect(pr.params._meta).toBeUndefined();
  });

  test('emits payment_rejected when resolvePrice returns reject: true', async () => {
    const processor = {
      pmi: 'fake',
      async createPaymentRequired() {
        throw new Error('Should not be called');
      },
      async verifyPayment() {
        throw new Error('Should not be called');
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 1,
        currencyUnit: 'test',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    const sent: Array<{ notification: unknown; requestEventId: string }> = [];
    const sender = {
      async sendNotification(
        _clientPubkey: string,
        notification: unknown,
        requestEventId: string,
      ): Promise<void> {
        sent.push({ notification, requestEventId });
      },
    };

    let forwardCalled = false;
    const forward = async () => {
      forwardCalled = true;
    };

    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
        resolvePrice: async () => ({
          reject: true,
          message: 'Capability already used',
        }),
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'event-id',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    await mw(message, ctx, forward);

    // Should emit payment_rejected
    const paymentRejected = sent.find(
      (x) =>
        typeof x.notification === 'object' &&
        x.notification !== null &&
        (x.notification as { method?: string }).method ===
          'notifications/payment_rejected',
    );
    expect(paymentRejected).toBeDefined();
    expect(paymentRejected?.requestEventId).toBe('event-id');

    const pr = paymentRejected!.notification as {
      params: { pmi: string; amount?: number; message?: string };
    };
    expect(pr.params.pmi).toBe('fake');
    expect(pr.params.amount).toBe(1);
    expect(pr.params.message).toBe('Capability already used');

    // Should NOT forward the request
    expect(forwardCalled).toBe(false);
  });

  test('emits payment_rejected without message when resolvePrice returns reject without message', async () => {
    const processor = {
      pmi: 'fake',
      async createPaymentRequired() {
        throw new Error('Should not be called');
      },
      async verifyPayment() {
        throw new Error('Should not be called');
      },
    };

    const pricedCapabilities = [
      {
        method: 'tools/call',
        name: 'add',
        amount: 5,
        currencyUnit: 'test',
      },
    ] as const;

    const ctx: { clientPubkey: string; clientPmis?: readonly string[] } = {
      clientPubkey: 'test-client',
    };

    const sent: Array<{ notification: unknown; requestEventId: string }> = [];
    const sender = {
      async sendNotification(
        _clientPubkey: string,
        notification: unknown,
        requestEventId: string,
      ): Promise<void> {
        sent.push({ notification, requestEventId });
      },
    };

    const mw = createServerPaymentsMiddleware({
      sender,
      options: {
        processors: [processor],
        pricedCapabilities: [...pricedCapabilities],
        resolvePrice: async () => ({ reject: true }),
      },
    });

    const message: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: 'event-id',
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 2 } },
    };

    await mw(message, ctx, async () => {});

    const paymentRejected = sent.find(
      (x) =>
        typeof x.notification === 'object' &&
        x.notification !== null &&
        (x.notification as { method?: string }).method ===
          'notifications/payment_rejected',
    );
    expect(paymentRejected).toBeDefined();

    const pr = paymentRejected!.notification as {
      params: { pmi: string; amount?: number; message?: string };
    };
    expect(pr.params.pmi).toBe('fake');
    expect(pr.params.amount).toBe(5);
    expect(pr.params.message).toBeUndefined();
  });
});
