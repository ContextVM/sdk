import type { JSONRPCResponse } from '@contextvm/mcp-sdk/types.js';
import type { RouteSnapshot } from '../transport/nostr-server/correlation-store.js';

/** Recorded result and route. Applications must protect the store as they protect paid result content. */
export interface PaymentResultDelivery {
  response: JSONRPCResponse;
  snapshot: RouteSnapshot;
  status: 'pending' | 'unknown' | 'published';
  /** A publication lease never restores or repeats an execution right. */
  owner?: string;
  leaseExpiresAtMs?: number;
  acknowledgedFrames: number;
  /** Fixed fragmentation contract, retained so retries use identical frame progress/digest. */
  chunkSizeBytes?: number;
}

/** Router hooks keep transport mechanics independent of payment storage implementations. */
export interface PaymentResultJournal {
  retain(
    eventId: string,
    response: JSONRPCResponse,
    snapshot: RouteSnapshot,
  ): Promise<void>;
  prepare(
    eventId: string,
    response: JSONRPCResponse,
    snapshot: RouteSnapshot,
  ): Promise<{
    publish: boolean;
    acknowledgedFrames: number;
    chunkSizeBytes?: number;
    framePublished: (count: number, chunkSizeBytes?: number) => Promise<void>;
    complete: () => Promise<void>;
    failed: () => Promise<void>;
  }>;
}
