import canonicalizePackage from 'canonicalize';
const encode = canonicalizePackage as unknown as (
  value: unknown,
) => string | undefined;

/** Encodes JSON with stable key ordering across memory and JSONB storage. */
export function canonicalJson(value: unknown): string {
  const encoded = encode(value);
  if (encoded === undefined)
    throw new TypeError('Value cannot be encoded as canonical JSON');
  return encoded;
}
