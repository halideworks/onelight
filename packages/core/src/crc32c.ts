import { base64UrlEncode } from "./crypto.js";

const table = (() => {
  const values = new Uint32Array(256);
  for (let index = 0; index < values.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
    values[index] = value >>> 0;
  }
  return values;
})();

export const crc32c = (bytes: Uint8Array, initial = 0xffffffff): number => {
  let value = initial >>> 0;
  for (const byte of bytes)
    value = (table[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

export const crc32cHex = (bytes: Uint8Array): string =>
  crc32c(bytes).toString(16).padStart(8, "0");

export const crc32cBase64 = (bytes: Uint8Array): string => {
  const value = crc32c(bytes);
  return base64UrlEncode(
    new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]),
  );
};

export const crc32cStream = async (
  stream: ReadableStream,
): Promise<{ hex: string; base64url: string }> => {
  const reader = stream.getReader();
  let value = 0xffffffff;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes =
        next.value instanceof Uint8Array
          ? next.value
          : new Uint8Array(next.value);
      for (const byte of bytes)
        value = (table[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
    }
  } finally {
    reader.releaseLock();
  }
  const checksum = (value ^ 0xffffffff) >>> 0;
  const bytes = new Uint8Array([
    checksum >>> 24,
    checksum >>> 16,
    checksum >>> 8,
    checksum,
  ]);
  return {
    hex: checksum.toString(16).padStart(8, "0"),
    base64url: base64UrlEncode(bytes),
  };
};

export const crc32cMatches = (
  expected: string,
  actual: { hex: string; base64url: string },
): boolean => {
  // Normalize only the base64 alphabet (+/ to -_) and strip padding; base64
  // is case-sensitive, so the comparison must be too. Hex alone is
  // case-insensitive.
  const normalized = expected
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return (
    normalized.toLowerCase() === actual.hex || normalized === actual.base64url
  );
};
