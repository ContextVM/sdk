import { expect, test } from 'bun:test';
import type { Transport } from '@contextvm/mcp-sdk/shared/transport';
import { withClientPayments } from './client-payments.js';

test('rejects more than 100 payment options before visiting entries or calling the wallet', async () => {
  const base: Transport = {
    async start(): Promise<void> {},
    async send(): Promise<void> {},
    async close(): Promise<void> {},
  };
  let visits = 0;
  let walletCalls = 0;
  const options = Array.from({ length: 101 }, () => ({}));
  Object.defineProperty(options, 0, {
    get: () => {
      visits++;
      throw new Error('entry visited');
    },
  });
  const paid = withClientPayments(base, {
    onPaymentRequired: async () => {
      walletCalls++;
      return { paid: false };
    },
  });
  const messages: unknown[] = [];
  paid.onmessage = (message) => messages.push(message);
  await paid.start();
  try {
    await paid.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'test' },
    });
    base.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32042,
        message: 'Payment Required',
        data: { payment_options: options },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(visits).toBe(0);
    expect(walletCalls).toBe(0);
    expect(messages).toContainEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32042,
        message: 'Payment Required',
        data: { reason: 'invalid_payment_options' },
      },
    });
  } finally {
    await paid.close();
  }
});
