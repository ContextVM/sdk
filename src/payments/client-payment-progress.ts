import type { JSONRPCMessage } from '@contextvm/mcp-sdk/types.js';

/** Maintains bounded synthetic MCP progress while transparent settlement is pending. */
export class ClientPaymentProgress {
  private readonly entries = new Map<
    string,
    { token: string | number; stopAt: number }
  >();
  private timer?: ReturnType<typeof setInterval>;

  public constructor(
    private readonly intervalMs: number,
    private readonly emit: (message: JSONRPCMessage) => void,
  ) {}

  private tick(): void {
    for (const [key, entry] of this.entries) {
      if (Date.now() >= entry.stopAt) this.stop(key);
      else this.heartbeat(entry.token);
    }
  }

  private heartbeat(token: string | number): void {
    this.emit({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 0 },
    });
  }

  /** Starts an immediate heartbeat and periodic resets for the request's wire token. */
  public start(key: string, token: string, ttlMs: number): void {
    if (this.entries.has(key)) return;
    const wireToken = Number.isFinite(Number(token)) ? Number(token) : token;
    this.entries.set(key, { token: wireToken, stopAt: Date.now() + ttlMs });
    if (!this.timer)
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.heartbeat(wireToken);
  }

  /** Stops only this generation's progress and reaps an idle scheduler. */
  public stop(key: string): void {
    this.entries.delete(key);
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Reaps every heartbeat during wrapper teardown. */
  public clear(): void {
    this.entries.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
