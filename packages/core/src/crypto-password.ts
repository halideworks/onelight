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
/* Chained, for the same total work in calls a Workers isolate will accept.
   A distinct prefix because it is a different function: a hash written by one
   scheme does not verify under the other, and guessing wrong rejects a correct
   password. */
const CHAINED_PREFIX = "$pbkdf2-sha256-c$";
const legacyIterations = 100_000; // hashes written before the floor was raised

const subtle = (): SubtleCrypto => {
  if (!globalThis.crypto) throw new Error("WebCrypto is required.");
  return globalThis.crypto.subtle;
};

/* Workers refuses more than this in one deriveBits call:
     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
     supported (requested 600000).
   Node has no such limit. The floor this app wants is 600,000, so on Workers
   the work has to be split across calls. */
const MAX_ITERATIONS_PER_CALL = 100_000;

const deriveOnce = async (
  material: Uint8Array,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const key = await subtle().importKey(
    "raw",
    new Uint8Array(material).buffer,
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

/**
 * PBKDF2 to a total iteration count, in chunks a Workers isolate will accept.
 *
 * Each chunk feeds the previous chunk's output back in as the password, so the
 * total work is the sum of the chunks: an attacker still pays 600,000
 * iterations of HMAC-SHA256 to test one guess, which is the property the
 * iteration count buys. It is not the same function as one 600,000-iteration
 * call, so a hash written by one cannot be verified by the other, and the
 * stored string records which it is.
 *
 * A count at or below the per-call limit takes the single call, so nothing
 * about existing hashes changes.
 */
const derive = async (
  plain: string,
  salt: Uint8Array,
  iterations: number,
  chained: boolean,
): Promise<Uint8Array> => {
  if (!chained) return deriveOnce(utf8(plain), salt, iterations);
  let material = utf8(plain);
  let remaining = iterations;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_ITERATIONS_PER_CALL);
    material = await deriveOnce(material, salt, chunk);
    remaining -= chunk;
  }
  return material;
};

/* The iteration count a stored hash was made with, or null if the string is
   not one of ours. Supports both the current `$pbkdf2-sha256$i=N$salt$hash`
   form and the original `$pbkdf2-sha256$i=100000$salt$hash` (same shape, so
   one parser covers both). */
const parse = (
  stored: string,
): {
  iterations: number;
  salt: Uint8Array;
  expected: Uint8Array;
  chained: boolean;
} | null => {
  const chained = stored.startsWith(CHAINED_PREFIX);
  if (!chained && !stored.startsWith(PREFIX)) return null;
  const parts = stored
    .slice((chained ? CHAINED_PREFIX : PREFIX).length)
    .split("$");
  if (parts.length !== 3) return null;
  const match = /^i=(\d+)$/.exec(parts[0] ?? "");
  if (!match) return null;
  const iterations = Number(match[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  return {
    iterations,
    salt: base64UrlDecode(parts[1] ?? ""),
    expected: base64UrlDecode(parts[2] ?? ""),
    chained,
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
    const derived = await derive(plain, salt, ITERATIONS, true);
    return `${CHAINED_PREFIX}i=${String(ITERATIONS)}$${base64UrlEncode(salt)}$${base64UrlEncode(derived)}`;
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const actual = await derive(
      plain,
      parsed.salt,
      parsed.iterations,
      parsed.chained,
    );
    if (actual.length !== parsed.expected.length) return false;
    let result = 0;
    for (let index = 0; index < actual.length; index += 1)
      result |= (actual[index] ?? 0) ^ (parsed.expected[index] ?? 0);
    return result === 0;
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    /* An unchained hash is re-hashed on the next successful login even at the
       right iteration count, because it is the form a Workers isolate cannot
       compute. Doing it on login is what lets a node deployment move to the
       Workers target without resetting anybody's password. */
    return parsed === null || parsed.iterations < ITERATIONS || !parsed.chained;
  }
}

export { ITERATIONS as PBKDF2_ITERATIONS, legacyIterations };
