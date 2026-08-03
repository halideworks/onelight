/* A secret an admin typed, kept in the database without being readable there.
 *
 * The SMTP password used to be stored as plaintext JSON in app_settings, and
 * the code defended it: the database of a self-hosted instance is where every
 * other credential already lives. That is true of hashes and of tokens the
 * instance mints, and it is not true of this one. An SMTP password is a
 * credential to a system somebody else runs, typed by an admin who probably
 * uses it elsewhere, and it ends up in every backup, every `sqlite3 .dump`,
 * and every screenshot of a support session. Nothing else in the schema has
 * that shape.
 *
 * So it is sealed with a key derived from SECRET_KEY, which already protects
 * sessions and signed media URLs and is the one value a deployment is told to
 * keep. That does not make the database safe to hand out -- an attacker with
 * both the database and the environment has everything -- and it is not meant
 * to. It separates the two, so a leaked backup is not a leaked password.
 *
 * WebCrypto only, so it works unchanged on the Workers target.
 */
import { base64UrlDecode, base64UrlEncode, utf8 } from "./crypto.js";

/* Versioned so the format can change without a migration guessing games:
   anything that does not start with this is not something this module wrote. */
const PREFIX = "v1";

/* Distinct from every other use of SECRET_KEY. HKDF with a fixed info string
   means the sealing key cannot be used to forge a session token, or the other
   way round, even though both come from the same secret. */
const INFO = "onelight.stored-secret.v1";

const IV_BYTES = 12;

const sealingKey = async (secretKey: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    utf8(secretKey) as BufferSource,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      /* No salt: the input is a single long-lived secret rather than a
         password, and a salt would have to be stored beside every value to be
         useful. The info string is what separates this use from the others. */
      salt: new Uint8Array(0) as BufferSource,
      info: utf8(INFO) as BufferSource,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

/** Whether a stored value is something this module produced. */
export const isSealed = (value: string): boolean =>
  value.startsWith(`${PREFIX}.`);

/**
 * Seal a secret for storage.
 *
 * A fresh IV every time, so writing the same password twice does not produce
 * the same ciphertext and a reader cannot tell that it was unchanged.
 */
export const seal = async (
  secretKey: string,
  plaintext: string,
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      await sealingKey(secretKey),
      utf8(plaintext) as BufferSource,
    ),
  );
  return `${PREFIX}.${base64UrlEncode(iv)}.${base64UrlEncode(sealed)}`;
};

/**
 * Open a sealed secret, or answer null.
 *
 * Null rather than a throw, because the reachable cause is a rotated
 * SECRET_KEY: every sealed value in the database becomes unreadable at once,
 * and the instance has to keep serving and say what is wrong. A caller turns
 * that into "mail is not configured", which is true, instead of a 500 on a
 * page that merely mentions mail.
 */
export const open = async (
  secretKey: string,
  value: string,
): Promise<string | null> => {
  if (!isSealed(value)) return null;
  const [, iv, sealed] = value.split(".");
  if (!iv || !sealed) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(iv) as BufferSource },
      await sealingKey(secretKey),
      base64UrlDecode(sealed) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
};

/**
 * Open a value that may predate sealing.
 *
 * Instances that stored a password before this existed have plaintext in the
 * column, and it keeps working: anything this module did not write is returned
 * as it is, and the next write seals it. There is no migration, because a
 * migration cannot reach the secret -- it lives in the environment, not in the
 * database being migrated.
 */
export const openStored = async (
  secretKey: string,
  value: string | null | undefined,
): Promise<string | null> => {
  if (!value) return null;
  return isSealed(value) ? open(secretKey, value) : value;
};
