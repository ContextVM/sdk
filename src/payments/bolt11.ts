import { bech32 } from '@scure/base';

/** Networks distinguishable from a BOLT11 human-readable prefix. */
export type Bolt11Network = 'bitcoin' | 'testnet' | 'signet' | 'regtest';

/** Invoice fields needed to bind a payment to its approved amount. */
export interface Bolt11Summary {
  network: Bolt11Network;
  /** Encoded amount; undefined for amountless invoices. */
  amountMsats?: number;
  /** Creation time in seconds. */
  timestamp: number;
  /** Lifetime after `timestamp`, in seconds (BOLT11 default: 3600). */
  expirySeconds: number;
}

/** Why an invoice cannot settle exactly the approved amount. */
export type Bolt11Mismatch = 'invalid' | 'network' | 'amount' | 'expired';

/** Raised before wallet or issuer side effects when an invoice does not match. */
export class Bolt11ValidationError extends Error {
  public constructor(public readonly reason: Bolt11Mismatch) {
    super(`BOLT11 invoice rejected: ${reason}`);
    this.name = 'Bolt11ValidationError';
  }
}

const NETWORKS: Record<string, Bolt11Network> = {
  bc: 'bitcoin',
  tb: 'testnet',
  tbs: 'signet',
  bcrt: 'regtest',
};
const MSATS_PER_UNIT: Record<string, number> = {
  '': 100_000_000_000,
  m: 100_000_000,
  u: 100_000,
  n: 100,
};
const TIMESTAMP_WORDS = 7;
const SIGNATURE_WORDS = 104;
const PAYMENT_HASH_TAG = 1;
const EXPIRY_TAG = 6;

const toInt = (words: readonly number[]): number =>
  words.reduce((value, word) => value * 32 + word, 0);

/** Decodes the fields used for payment binding; the payee signature is not verified. */
export function decodeBolt11(invoice: string): Bolt11Summary {
  const decoded = bech32.decodeUnsafe(invoice, false);
  const hrp =
    decoded &&
    /^ln(bcrt|bc|tbs|tb)(?:([1-9]\d*)([munp]?))?$/.exec(decoded.prefix);
  const [, prefix = '', digits, unit = ''] = hrp ?? [];
  const network = NETWORKS[prefix];
  if (!decoded || !network) throw new Bolt11ValidationError('invalid');
  let amountMsats: number | undefined;
  if (digits !== undefined) {
    const value = Number(digits);
    amountMsats =
      unit === 'p' ? value / 10 : value * (MSATS_PER_UNIT[unit] ?? NaN);
    // Rejects sub-millisatoshi pico amounts and values beyond exact arithmetic.
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(amountMsats))
      throw new Bolt11ValidationError('invalid');
  }
  const words = decoded.words;
  const end = words.length - SIGNATURE_WORDS;
  if (end < TIMESTAMP_WORDS) throw new Bolt11ValidationError('invalid');
  let expirySeconds = 3600;
  let hasPaymentHash = false;
  for (let i = TIMESTAMP_WORDS; i < end;) {
    const [tag, high, low] = words.slice(i, i + 3);
    if (high === undefined || low === undefined)
      throw new Bolt11ValidationError('invalid');
    const length = high * 32 + low;
    if (i + 3 + length > end) throw new Bolt11ValidationError('invalid');
    const data = words.slice(i + 3, i + 3 + length);
    if (tag === PAYMENT_HASH_TAG && length === 52) hasPaymentHash = true;
    if (tag === EXPIRY_TAG) {
      if (length > 10) throw new Bolt11ValidationError('invalid');
      expirySeconds = toInt(data);
    }
    i += 3 + length;
  }
  if (!hasPaymentHash) throw new Bolt11ValidationError('invalid');
  return {
    network,
    ...(amountMsats !== undefined && { amountMsats }),
    timestamp: toInt(words.slice(0, TIMESTAMP_WORDS)),
    expirySeconds,
  };
}

/**
 * Binds an invoice to an approved sats amount before any wallet or issuer side
 * effect. Amountless invoices are refused because the approval cannot be enforced.
 */
export function assertBolt11Amount(
  invoice: string,
  expected: { amountSats: number; network?: Bolt11Network; nowMs?: number },
): Bolt11Summary {
  const summary = decodeBolt11(invoice);
  if (expected.network !== undefined && summary.network !== expected.network)
    throw new Bolt11ValidationError('network');
  if (summary.amountMsats !== Math.round(expected.amountSats * 1000))
    throw new Bolt11ValidationError('amount');
  if (
    (summary.timestamp + summary.expirySeconds) * 1000 <=
    (expected.nowMs ?? Date.now())
  )
    throw new Bolt11ValidationError('expired');
  return summary;
}
