/* TOTP (RFC 6238) over WebCrypto, so the same code runs on Node and on
 * Workers. SHA-1 is what every authenticator app implements; it is used
 * here as an HMAC PRF per the RFC, not as a collision-resistant hash.
 */

import { constantTimeEqual, randomBytes, utf8 } from "./crypto.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

export const base32Decode = (encoded: string): Uint8Array => {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
};

/* 160-bit secret, the RFC's recommended size for HMAC-SHA-1. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpCode = async (
  secret: string,
  timestampMs: number,
  stepSeconds = 30,
  digits = 6,
): Promise<string> => {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const message = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining & 255;
    remaining = Math.floor(remaining / 256);
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    base32Decode(secret).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, message.buffer),
  );
  const offset = (mac[mac.length - 1] ?? 0) & 15;
  const binary =
    (((mac[offset] ?? 0) & 127) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
};

/* Accepts the current step and one step either side, the usual allowance
   for clock skew and slow typing. Comparison is constant-time. */
export const verifyTotp = async (
  secret: string,
  code: string,
  timestampMs: number,
  window = 1,
): Promise<boolean> => {
  const candidate = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(candidate)) return false;
  for (let step = -window; step <= window; step += 1) {
    const expected = await totpCode(secret, timestampMs + step * 30_000);
    if (constantTimeEqual(utf8(expected), utf8(candidate))) return true;
  }
  return false;
};

export const otpauthUrl = (
  secret: string,
  account: string,
  issuer = "Onelight",
): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* Backup codes: ten characters of base32 apiece, shown once and stored only
   as hashes by the caller. */
export const generateBackupCodes = (count = 8): string[] =>
  Array.from({ length: count }, () =>
    base32Encode(randomBytes(6)).slice(0, 10),
  );
