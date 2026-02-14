import { kinds, type NostrEvent } from 'nostr-tools';
import { type EventTemplate } from 'nostr-tools/pure';

export function createZapRequest(params: {
  amountMsats: number;
  recipientPubkey: string;
  relays: string[];
}): EventTemplate {
  return {
    kind: kinds.ZapRequest,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['relays', ...params.relays],
      ['amount', params.amountMsats.toString()],
      ['p', params.recipientPubkey],
    ],
  };
}

export function getBolt11FromZapReceipt(event: NostrEvent): string | undefined {
  return event.tags.find((t) => t[0] === 'bolt11')?.[1];
}
