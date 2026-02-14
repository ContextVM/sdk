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
}): Promise<LnurlPayParams> {
  const { username, domain } = parseLnAddress(params.lnAddress);
  const url = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`;

  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LNURL-pay fetch failed: ${response.status} ${text}`);
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
}): Promise<{ pr: string }> {
  const url = new URL(params.callback);
  url.searchParams.set('amount', params.amountMsats.toString());
  url.searchParams.set('nostr', params.zapRequestJson);

  const response = await fetch(url.toString(), { method: 'GET' });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LNURL callback failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as { pr?: string; reason?: string };
  if (!json.pr) {
    throw new Error(
      `LNURL callback missing pr${json.reason ? `: ${json.reason}` : ''}`,
    );
  }
  return { pr: json.pr };
}
