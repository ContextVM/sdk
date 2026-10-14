import type { JSONRPCRequest } from '@contextvm/mcp-sdk/types.js';
import { LruCache } from '../core/utils/lru-cache.js';
import type { ClientPaymentLimits } from './client-payment-options.js';
import type { PaymentOption } from './types.js';
import { ClientPaymentError } from './client-payment-validation.js';

/** One caller request generation, including its automatic payment retries. */
export interface ClientPaymentRequest {
  key: string;
  id?: string | number;
  request?: JSONRPCRequest;
  controller: AbortController;
  active: boolean;
  retries: number;
  attempts: number;
  paymentInFlight: boolean;
  amounts: Map<string, number>;
  deadline?: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/** Owns request generations, deadlines, limits, and retry timer cancellation. */
export class ClientPaymentLifecycle {
  private readonly requests: LruCache<ClientPaymentRequest>;
  private closed = false;

  public constructor(
    private readonly limits: ClientPaymentLimits | undefined,
    private readonly onFailure: (
      request: ClientPaymentRequest,
      error: ClientPaymentError,
    ) => void,
    private readonly onFinish: (request: ClientPaymentRequest) => void,
  ) {
    this.requests = new LruCache(1000, (_key, request) => {
      if (!request.active) return;
      this.finish(request);
      this.onFailure(
        request,
        new ClientPaymentError(
          'payment_request_capacity',
          'Client request capacity reached',
        ),
      );
    });
  }

  /** Makes future generations usable; closed generations remain inactive. */
  public open(): void {
    this.closed = false;
  }

  /** Whether the wrapper has begun closing. */
  public get isClosed(): boolean {
    return this.closed;
  }

  /** Finds the current generation using a type-aware JSON-RPC identifier. */
  public get(id: string | number): ClientPaymentRequest | undefined {
    return this.requests.get(JSON.stringify(['request', id]));
  }

  private create(
    key: string,
    id?: string | number,
    request?: JSONRPCRequest,
  ): ClientPaymentRequest {
    const prior = this.requests.get(key);
    if (prior) this.finish(prior);
    const state: ClientPaymentRequest = {
      key,
      id,
      request,
      active: true,
      controller: new AbortController(),
      retries: 0,
      attempts: 0,
      paymentInFlight: false,
      amounts: new Map(),
    };
    this.requests.set(key, state);
    return state;
  }

  /** Records the wire-shaped request before publishing and isolates it from callbacks. */
  public register(request: JSONRPCRequest): ClientPaymentRequest {
    if (this.closed) throw new Error('Client payments transport is closed');
    const copy = JSON.parse(JSON.stringify(request)) as JSONRPCRequest;
    return this.create(
      JSON.stringify(['request', request.id]),
      request.id,
      copy,
    );
  }

  /** Adopts correlation supplied by a transport when no original request was cached. */
  public correlated(id: string | number): ClientPaymentRequest {
    return this.get(id) ?? this.create(JSON.stringify(['request', id]), id);
  }

  /** Returns the sole live invocation for an uncorrelated generic transport. */
  public onlyRequest(): ClientPaymentRequest | undefined {
    const active = [...this.requests.entries()]
      .map(([, state]) => state)
      .filter((state) => state.active && state.request);
    return active.length === 1 ? active[0] : undefined;
  }

  /** Whether a generic notification is ambiguous between multiple invocations. */
  public hasRequests(): boolean {
    return [...this.requests.entries()].some(
      ([, state]) => state.active && state.request !== undefined,
    );
  }

  /** Tracks legacy standalone notifications in the generic transport's scope. */
  public detached(eventId: string): ClientPaymentRequest {
    const key = JSON.stringify(['event', eventId]);
    return this.requests.get(key) ?? this.create(key);
  }

  /** Checks generation ownership and expires an elapsed payment deadline. */
  public isActive(state: ClientPaymentRequest): boolean {
    if (this.closed || !state.active || this.requests.get(state.key) !== state)
      return false;
    if (state.deadline !== undefined && Date.now() >= state.deadline) {
      this.expire(state);
      return false;
    }
    return true;
  }

  private expire(state: ClientPaymentRequest): void {
    if (!state.active) return;
    this.finish(state);
    this.onFailure(
      state,
      new ClientPaymentError(
        'payment_deadline_exceeded',
        'Client payment deadline exceeded',
      ),
    );
  }

  /** Starts one deadline spanning every offer and pending response for this invocation. */
  public startPayment(state: ClientPaymentRequest): void {
    if (this.limits?.timeoutMs === undefined || state.deadline !== undefined)
      return;
    state.deadline = Date.now() + this.limits.timeoutMs;
    state.deadlineTimer = setTimeout(
      () => this.expire(state),
      this.limits.timeoutMs,
    );
  }

  /** Reserves a conservative per-PMI approval budget before external code runs. */
  public approve(
    state: ClientPaymentRequest,
    options: readonly PaymentOption[],
  ): PaymentOption[] {
    const limits = this.limits;
    if (
      limits?.maxAttempts !== undefined &&
      state.attempts >= limits.maxAttempts
    ) {
      throw new ClientPaymentError(
        'payment_limit_exceeded',
        'Client payment attempt limit exceeded',
      );
    }
    const allowed = options.filter((option) => {
      if (limits?.maxAmountByPmi === undefined) return true;
      const bound = limits.maxAmountByPmi[option.pmi];
      return (
        bound !== undefined &&
        option.amount <= bound - (state.amounts.get(option.pmi) ?? 0)
      );
    });
    if (allowed.length === 0) {
      throw new ClientPaymentError(
        'payment_limit_exceeded',
        'Client payment amount limit exceeded',
      );
    }
    const reserved = new Map<string, number>();
    for (const option of allowed)
      reserved.set(
        option.pmi,
        Math.max(reserved.get(option.pmi) ?? 0, option.amount),
      );
    for (const [pmi, amount] of reserved)
      state.amounts.set(pmi, (state.amounts.get(pmi) ?? 0) + amount);
    state.attempts++;
    return allowed;
  }

  /** Reaps request-owned timers and signals before any terminal callback is delivered. */
  public finish(state: ClientPaymentRequest): void {
    if (!state.active) return;
    state.active = false;
    clearTimeout(state.retryTimer);
    clearTimeout(state.deadlineTimer);
    state.retryTimer = undefined;
    state.controller.abort();
    // Retain an inactive generation so late offers cannot revive a terminal id.
    state.request = undefined;
    state.amounts.clear();
    this.onFinish(state);
  }

  /** Stops every current generation synchronously, even when transport close awaits I/O. */
  public close(): void {
    this.closed = true;
    for (const [, state] of [...this.requests.entries()]) this.finish(state);
    this.requests.clear();
  }
}
