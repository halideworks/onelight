import {
  base64UrlDecode,
  base64UrlEncode,
  randomBytes,
  utf8,
} from "./crypto.js";

const PBKDF2_PREFIX = "$pbkdf2-sha256$i=100000$";
const ITERATIONS = 100_000;

const subtle = (): SubtleCrypto => {
  if (!globalThis.crypto) throw new Error("WebCrypto is required.");
  return globalThis.crypto.subtle;
};

const derive = async (plain: string, salt: Uint8Array): Promise<Uint8Array> => {
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
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return new Uint8Array(bits);
};

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, stored: string): Promise<boolean>;
}

export class Pbkdf2PasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await derive(plain, salt);
    return `${PBKDF2_PREFIX}${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    if (!stored.startsWith(PBKDF2_PREFIX)) return false;
    const rest = stored.slice(PBKDF2_PREFIX.length).split("$");
    if (rest.length !== 2) return false;
    const salt = base64UrlDecode(rest[0] ?? "");
    const expected = base64UrlDecode(rest[1] ?? "");
    const actual = await derive(plain, salt);
    if (actual.length !== expected.length) return false;
    let result = 0;
    for (let index = 0; index < actual.length; index += 1)
      result |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
    return result === 0;
  }
}
