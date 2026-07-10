const textEncoder = new TextEncoder();

/**
 * Encodes a UTF-8 string as Base64 using the native Web Platform `btoa`
 * (available in browsers and Node 16+).
 *
 * The `TextEncoder` bridge preserves UTF-8 byte encoding so non-ASCII
 * credentials (e.g. RFC 7617 UTF-8 Basic Auth) round-trip correctly; naked
 * `btoa(value)` only handles Latin-1.
 */
export function encodeBase64(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
