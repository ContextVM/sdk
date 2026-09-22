import { describe, expect, test } from 'bun:test';
import { encodeBase64 } from './base64.js';

describe('encodeBase64', () => {
  // 1. Empty input
  test('returns empty string for empty input', () => {
    expect(encodeBase64('')).toBe('');
  });

  // 2. Ordinary ASCII credentials
  test('encodes plain ASCII credentials correctly', () => {
    expect(encodeBase64('admin:password')).toBe('YWRtaW46cGFzc3dvcmQ=');
  });

  // 3. One-byte and two-byte padding cases
  test('produces two padding characters for a one-byte input', () => {
    expect(encodeBase64('M')).toBe('TQ==');
  });

  test('produces one padding character for a two-byte input', () => {
    expect(encodeBase64('Ma')).toBe('TWE=');
  });

  test('produces no padding characters for a three-byte input', () => {
    expect(encodeBase64('Man')).toBe('TWFu');
  });

  // 4. Non-ASCII/UTF-8 credentials
  test('encodes a string containing a two-byte UTF-8 sequence (é)', () => {
    expect(encodeBase64('café')).toBe('Y2Fmw6k=');
  });

  test('encodes Basic Auth credentials with non-ASCII characters', () => {
    expect(encodeBase64('user:pässwörd')).toBe('dXNlcjpww6Rzc3fDtnJk');
  });

  test('encodes Japanese hiragana (three-byte UTF-8 sequences)', () => {
    expect(encodeBase64('こんにちは')).toBe('44GT44KT44Gr44Gh44Gv');
  });

  // 5. Deterministic output matching known Base64 vectors
  test('produces identical output on repeated calls with the same input', () => {
    const input = 'admin:s3cr3t!';
    const first = encodeBase64(input);
    const second = encodeBase64(input);

    expect(first).toBe(second);
    expect(first).toBe('YWRtaW46czNjcjN0IQ==');
  });
});
