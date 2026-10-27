import type { PaymentFetch } from '../payment-cancellation.js';
export type LnurlPayParams = {
  callback: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
  minSendable?: number;
  maxSendable?: number;
};

export function parseLnAddress(lnAddress: string): {
  username: string;
  domain: string;
} {
  const parts = lnAddress.split('@');
  if (parts.length !== 2) {
    throw new Error(`Invalid lnAddress: ${lnAddress}`);
  }
  const [username, domain] = parts;
  if (!username || !domain) {
    throw new Error(`Invalid lnAddress: ${lnAddress}`);
  }
  return { username, domain };
}

export async function fetchLnurlPayParams(params: {
  lnAddress: string;
  abortSignal?: AbortSignal;
  fetch?: PaymentFetch;
}): Promise<LnurlPayParams> {
  params.abortSignal?.throwIfAborted();
  const { username, domain } = parseLnAddress(params.lnAddress);
  const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`;

  const response = await (params.fetch ?? globalThis.fetch)(url, {
    method: 'GET',
    signal: params.abortSignal,
  });
  if (!response.ok) {
    throw new Error(`LNURL-pay fetch failed: ${response.status}`);
  }

  const json = (await response.json()) as LnurlPayParams;
  if (!json.callback) {
    throw new Error('LNURL-pay response missing callback');
  }
  return json;
}

export async function requestZapInvoice(params: {
  callback: string;
  amountMsats: number;
  zapRequestJson: string;
  abortSignal?: AbortSignal;
  fetch?: PaymentFetch;
}): Promise<{ pr: string }> {
  params.abortSignal?.throwIfAborted();
  const url = new URL(params.callback);
  url.searchParams.set('amount', params.amountMsats.toString());
  url.searchParams.set('nostr', params.zapRequestJson);

  const response = await (params.fetch ?? globalThis.fetch)(url.toString(), {
    method: 'GET',
    signal: params.abortSignal,
  });
  if (!response.ok) {
    throw new Error(`LNURL callback failed: ${response.status}`);
  }

  const json = (await response.json()) as { pr?: string; reason?: string };
  if (!json.pr) {
    throw new Error('LNURL callback missing pr');
  }
  return { pr: json.pr };
}
