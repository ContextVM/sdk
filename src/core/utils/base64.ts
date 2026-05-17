const textEncoder = new TextEncoder();

const base64Alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encodes a UTF-8 string as Base64 without relying on Node.js globals. */
export function encodeBase64(value: string): string {
  const bytes = textEncoder.encode(value);
  let result = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] ?? 0;
    const byte1 = bytes[index + 1] ?? 0;
    const byte2 = bytes[index + 2] ?? 0;
    const chunk = (byte0 << 16) | (byte1 << 8) | byte2;

    result += base64Alphabet[(chunk >> 18) & 0x3f] ?? '';
    result += base64Alphabet[(chunk >> 12) & 0x3f] ?? '';
    result +=
      index + 1 < bytes.length
        ? (base64Alphabet[(chunk >> 6) & 0x3f] ?? '')
        : '=';
    result +=
      index + 2 < bytes.length ? (base64Alphabet[chunk & 0x3f] ?? '') : '=';
  }

  return result;
}
