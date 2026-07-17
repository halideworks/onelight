import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  verifyTotp,
} from "./totp.js";

/* RFC 6238 Appendix B vectors, SHA-1, truncated from 8 to 6 digits. The
   published secret is the ASCII bytes of "12345678901234567890". */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("round-trips base32", () => {
    const bytes = Uint8Array.from([49, 50, 51, 52, 53, 54, 55, 56, 57, 48]);
    const encoded = base32Encode(bytes);
    expect(base32Decode(encoded)).toEqual(bytes);
    expect(base32Decode("gezd gnbv")).toEqual(base32Decode("GEZDGNBV"));
  });

  it("matches the RFC 6238 SHA-1 vectors", async () => {
    expect(await totpCode(RFC_SECRET, 59_000)).toBe("287082");
    expect(await totpCode(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
    expect(await totpCode(RFC_SECRET, 20_000_000_000_000)).toBe("353130");
  });

  it("verifies with one step of skew and rejects beyond it", async () => {
    const now = 1_111_111_109_000;
    const code = await totpCode(RFC_SECRET, now);
    expect(await verifyTotp(RFC_SECRET, code, now)).toBe(true);
    expect(await verifyTotp(RFC_SECRET, code, now + 30_000)).toBe(true);
    expect(await verifyTotp(RFC_SECRET, code, now + 90_000)).toBe(false);
    expect(await verifyTotp(RFC_SECRET, "000 000", now)).toBe(false);
    expect(await verifyTotp(RFC_SECRET, "not-a-code", now)).toBe(false);
  });

  it("generates well-formed secrets, urls, and backup codes", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl(secret, "d@example.com")).toContain(
      `secret=${secret}&issuer=Onelight`,
    );
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(8);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(new Set(codes).size).toBe(8);
  });
});
