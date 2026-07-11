const encoder = new TextEncoder();
const decoder = new TextDecoder();

const cryptoApi = (): Crypto => {
  if (globalThis.crypto) return globalThis.crypto;
  throw new Error("WebCrypto is required.");
};

export const randomBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  cryptoApi().getRandomValues(bytes);
  return bytes;
};

export const base64UrlEncode = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export const base64UrlDecode = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
    char.charCodeAt(0),
  );

export const sha256 = async (
  value: string | Uint8Array,
): Promise<Uint8Array> => {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(
    await cryptoApi().subtle.digest("SHA-256", new Uint8Array(input).buffer),
  );
};

export const sha256Hex = async (value: string | Uint8Array): Promise<string> =>
  Array.from(await sha256(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const hmacSha256 = async (
  secret: string,
  value: string | Uint8Array,
): Promise<Uint8Array> => {
  const key = await cryptoApi().subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(
    await cryptoApi().subtle.sign("HMAC", key, new Uint8Array(input).buffer),
  );
};

export const hmacSha256Hex = async (
  secret: string,
  value: string | Uint8Array,
): Promise<string> =>
  Array.from(await hmacSha256(secret, value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const constantTimeEqual = (
  left: Uint8Array,
  right: Uint8Array,
): boolean => {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return result === 0;
};

export const utf8 = (value: string): Uint8Array => encoder.encode(value);
export const text = (value: Uint8Array): string => decoder.decode(value);
