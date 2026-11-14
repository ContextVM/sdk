import { Client } from '@contextvm/mcp-sdk/client';
import { McpServer } from '@contextvm/mcp-sdk/server/mcp';
import type { CallToolResult } from '@contextvm/mcp-sdk/types.js';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { z } from 'zod';
import { EncryptionMode, GiftWrapMode } from '../../core/interfaces.js';
import { PrivateKeySigner } from '../../signer/private-key-signer.js';
import { NostrClientTransport } from '../../transport/nostr-client-transport.js';
import { NostrServerTransport } from '../../transport/nostr-server-transport.js';
import { withClientPayments } from '../../payments/client-payments.js';
import type { ClientPaymentsOptions } from '../../payments/client-payment-options.js';
import { withServerPayments } from '../../payments/server-transport-payments.js';
import type { ServerPaymentsOptions } from '../../payments/server-payments.js';
import { InMemoryPaymentStateStore } from '../../payments/in-memory-payment-state-store.js';
import type { PaymentStateStore } from '../../payments/payment-state-store.js';
import type {
  PaymentHandler,
  PaymentInteractionMode,
  PaymentProcessor,
} from '../../payments/types.js';
import { FaultRelayHub } from './fault-relay-hub.js';
import { LifecycleProbe } from './lifecycle-probe.js';

/** CEP-8-conforming PMI for the deterministic test rail. */
export const TEST_PMI = 'test-rail';

export type TransportProfile = 'cleartext' | 'persistent' | 'ephemeral';
export const TRANSPORT_PROFILES: readonly TransportProfile[] = [
  'cleartext',
  'persistent',
  'ephemeral',
];

const ENCRYPTION = {
  cleartext: [EncryptionMode.DISABLED, GiftWrapMode.OPTIONAL],
  persistent: [EncryptionMode.REQUIRED, GiftWrapMode.PERSISTENT],
  ephemeral: [EncryptionMode.REQUIRED, GiftWrapMode.EPHEMERAL],
} as const;

/** Receiver-side ledger: settlement exists only after a wallet submission. */
export class SettlementLedger {
  private readonly paid = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  public pay(payReq: string): void {
    this.paid.add(payReq);
    for (const wake of this.waiters.get(payReq) ?? []) wake();
    this.waiters.delete(payReq);
  }

  public settled(payReq: string, signal?: AbortSignal): Promise<void> {
    if (this.paid.has(payReq)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
      this.waiters.set(payReq, [...(this.waiters.get(payReq) ?? []), resolve]);
    });
  }
}

export interface PaidScenarioOptions {
  profile?: TransportProfile;
  /** Client-requested lifecycle. @default 'transparent' */
  interaction?: PaymentInteractionMode;
  amount?: number;
  /** Offer TTL in seconds. @default 30 */
  ttl?: number;
  /** Replaces or wraps the default ledger-backed processor. */
  processor?: (base: PaymentProcessor) => PaymentProcessor;
  server?: Partial<ServerPaymentsOptions>;
  client?: Partial<ClientPaymentsOptions>;
}

/** A paying client attached to the scenario's relay. */
export interface ScenarioClient {
  party: string;
  pubkey: string;
  client: Client;
  call(value?: number, timeoutMs?: number): Promise<CallToolResult>;
}

/**
 * One paid server identity and its clients over a {@link FaultRelayHub}. The
 * payment store survives {@link PaidScenario.restartServer}, modelling transport
 * recreation inside one process, never a process restart.
 */
export class PaidScenario {
  public readonly hub = new FaultRelayHub();
  public readonly probe = new LifecycleProbe();
  public readonly ledger = new SettlementLedger();
  public readonly backend = new InMemoryPaymentStateStore();
  public readonly serverPubkey: string;
  public serverTransport!: NostrServerTransport;
  public readonly clients: ScenarioClient[] = [];
  private readonly serverKey = generateSecretKey();
  private readonly servers: McpServer[] = [];
  private invoices = 0;

  public constructor(private readonly options: PaidScenarioOptions = {}) {
    this.serverPubkey = getPublicKey(this.serverKey);
  }

  public get profile(): TransportProfile {
    return this.options.profile ?? 'cleartext';
  }

  /** Starts the server and one client labelled `client`. */
  public async start(): Promise<ScenarioClient> {
    await this.startServer();
    return this.addClient('client');
  }

  /** Closes the current server transport and attaches a fresh one to the same store. */
  public async restartServer(): Promise<void> {
    await Promise.all(this.servers.splice(0).map((server) => server.close()));
    await this.startServer();
  }

  public async addClient(party: string): Promise<ScenarioClient> {
    const [encryptionMode, giftWrapMode] = ENCRYPTION[this.profile];
    const key = generateSecretKey();
    const handler = this.probe.handler({
      pmi: TEST_PMI,
      handle: async (req) => this.ledger.pay(req.pay_req),
    });
    const explicit = this.options.interaction === 'explicit_gating';
    const transport = withClientPayments(
      new NostrClientTransport({
        signer: new PrivateKeySigner(bytesToHex(key)),
        relayHandler: this.hub.createRelayHandler(party),
        serverPubkey: this.serverPubkey,
        encryptionMode,
        giftWrapMode,
      }),
      {
        handlers: [handler],
        ...(explicit
          ? {
              paymentInteraction: 'explicit_gating',
              onPaymentRequired: async ({ options: [option] }) => {
                this.probe.mark('approved');
                if (!option) return { paid: false };
                await this.pay(handler, option.pay_req, option.amount);
                return { paid: true };
              },
            }
          : {
              paymentPolicy: async (): Promise<boolean> => {
                this.probe.mark('approved');
                return true;
              },
            }),
        ...this.options.client,
      },
    );
    const client = new Client({ name: party, version: '1.0.0' });
    await client.connect(transport);
    const entry: ScenarioClient = {
      party,
      pubkey: getPublicKey(key),
      client,
      call: async (value = 7, timeoutMs = 10_000) => {
        const result = (await client.callTool(
          { name: 'paid', arguments: { value } },
          undefined,
          { timeout: timeoutMs },
        )) as CallToolResult;
        this.probe.mark('received');
        return result;
      },
    };
    this.clients.push(entry);
    return entry;
  }

  /** Signs a cleartext ContextVM message as the server, for forged-ingress tests. */
  public signAsServer(
    message: Record<string, unknown>,
    tags: string[][],
  ): NostrEvent {
    return finalizeEvent(
      {
        kind: 25910,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: JSON.stringify(message),
      },
      this.serverKey,
    );
  }

  public async close(): Promise<void> {
    await Promise.allSettled(this.clients.map(({ client }) => client.close()));
    await Promise.allSettled(this.servers.map((server) => server.close()));
  }

  private async pay(
    handler: PaymentHandler,
    payReq: string,
    amount: number,
  ): Promise<void> {
    await handler.handle({
      amount,
      pay_req: payReq,
      pmi: TEST_PMI,
      requestEventId: 'explicit',
    });
  }

  private async startServer(): Promise<void> {
    const [encryptionMode, giftWrapMode] = ENCRYPTION[this.profile];
    const base: PaymentProcessor = {
      pmi: TEST_PMI,
      currencyUnit: 'sats',
      createPaymentRequired: async (params) => ({
        amount: params.amount,
        pmi: TEST_PMI,
        pay_req: `test-invoice-${++this.invoices}`,
        ttl: this.options.ttl ?? 30,
      }),
      verifyPayment: async (params) => {
        await this.ledger.settled(params.pay_req, params.abortSignal);
        return { _meta: { receipt: params.pay_req } };
      },
    };
    const processor = this.probe.processor(
      this.options.processor?.(base) ?? base,
    );
    const server = new McpServer({ name: 'cep8-server', version: '1.0.0' });
    server.registerTool(
      'paid',
      { inputSchema: { value: z.number() } },
      async ({ value }) => {
        this.probe.mark('dispatched');
        const result = {
          content: [{ type: 'text' as const, text: `${value}` }],
        };
        this.probe.mark('completed');
        return result;
      },
    );
    const transport = withServerPayments(
      new NostrServerTransport({
        signer: new PrivateKeySigner(bytesToHex(this.serverKey)),
        relayHandler: this.hub.createRelayHandler('server'),
        encryptionMode,
        giftWrapMode,
      }),
      {
        processors: [processor],
        stateStore: this.probe.store(this.backend) as PaymentStateStore,
        pricedCapabilities: [
          {
            method: 'tools/call',
            name: 'paid',
            amount: this.options.amount ?? 5,
            currencyUnit: 'sats',
          },
        ],
        ...this.options.server,
      },
    );
    const send = transport.send.bind(transport);
    transport.send = async (message, ...rest): Promise<void> => {
      await send(message, ...rest);
      // Tool results only: initialization and list responses are not paid output.
      if ('result' in message && 'content' in message.result)
        this.probe.mark('published');
    };
    this.servers.push(server);
    await server.connect(transport);
    this.serverTransport = transport;
  }
}
