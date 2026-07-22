import {
  base64UrlDecode,
  base64UrlEncode,
  randomBytes,
  utf8,
} from "./crypto.js";

/* PBKDF2-HMAC-SHA256. New hashes use OWASP's current floor for this KDF; the
   iteration count is written into the hash string, so a stored hash is
   verified at whatever count it was made with and old hashes keep verifying
   after this floor rises. verify() reads the count; only hash() picks it. */
const ITERATIONS = 600_000;
const PREFIX = "$pbkdf2-sha256$";
const legacyIterations = 100_000; // hashes written before the floor was raised

const subtle = (): SubtleCrypto => {
  if (!globalThis.crypto) throw new Error("WebCrypto is required.");
  return globalThis.crypto.subtle;
};

const derive = async (
  plain: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const key = await subtle().importKey(
    "raw",
    new Uint8Array(utf8(plain)).buffer,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await subtle().deriveBits(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt).buffer,
      iterations,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return new Uint8Array(bits);
};

/* The iteration count a stored hash was made with, or null if the string is
   not one of ours. Supports both the current `$pbkdf2-sha256$i=N$salt$hash`
   form and the original `$pbkdf2-sha256$i=100000$salt$hash` (same shape, so
   one parser covers both). */
const parse = (
  stored: string,
): { iterations: number; salt: Uint8Array; expected: Uint8Array } | null => {
  if (!stored.startsWith(PREFIX)) return null;
  const parts = stored.slice(PREFIX.length).split("$");
  if (parts.length !== 3) return null;
  const match = /^i=(\d+)$/.exec(parts[0] ?? "");
  if (!match) return null;
  const iterations = Number(match[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  return {
    iterations,
    salt: base64UrlDecode(parts[1] ?? ""),
    expected: base64UrlDecode(parts[2] ?? ""),
  };
};

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, stored: string): Promise<boolean>;
  /* True when a verified hash was made at fewer iterations than the current
     floor, so the caller can transparently re-hash on a successful login. */
  needsRehash(stored: string): boolean;
}

export class Pbkdf2PasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await derive(plain, salt, ITERATIONS);
    return `${PREFIX}i=${String(ITERATIONS)}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const actual = await derive(plain, parsed.salt, parsed.iterations);
    if (actual.length !== parsed.expected.length) return false;
    let result = 0;
    for (let index = 0; index < actual.length; index += 1)
      result |= (actual[index] ?? 0) ^ (parsed.expected[index] ?? 0);
    return result === 0;
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    return parsed === null || parsed.iterations < ITERATIONS;
  }
}

export { ITERATIONS as PBKDF2_ITERATIONS, legacyIterations };
