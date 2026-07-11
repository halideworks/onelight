import { describe, expect, it } from "vitest";
import { crc32cBase64, crc32cHex, crc32cMatches } from "./crc32c.js";

describe("CRC32C", () => {
  it("matches the Castagnoli check value for 123456789", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(crc32cHex(bytes)).toBe("e3069283");
    expect(
      crc32cMatches("e3069283", {
        hex: crc32cHex(bytes),
        base64url: crc32cBase64(bytes),
      }),
    ).toBe(true);
  });

  it("compares base64 checksums case-sensitively", () => {
    // crc32c("cl") = 0x699fa6ff, standard base64 "aZ+m/w==", url "aZ-m_w".
    const bytes = new TextEncoder().encode("cl");
    const actual = { hex: crc32cHex(bytes), base64url: crc32cBase64(bytes) };
    expect(actual.base64url).toBe("aZ-m_w");
    expect(crc32cMatches("aZ-m_w", actual)).toBe(true);
    expect(crc32cMatches("aZ+m/w==", actual)).toBe(true);
    expect(crc32cMatches("az+m/w==", actual)).toBe(false);
    expect(crc32cMatches("AZ-M_W", actual)).toBe(false);
  });

  it("compares hex checksums case-insensitively", () => {
    const bytes = new TextEncoder().encode("123456789");
    const actual = { hex: crc32cHex(bytes), base64url: crc32cBase64(bytes) };
    expect(crc32cMatches("E3069283", actual)).toBe(true);
    expect(crc32cMatches("e3069283", actual)).toBe(true);
    expect(crc32cMatches("4wasgw", actual)).toBe(false);
  });
});
