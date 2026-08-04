import { describe, expect, it } from "vitest";
import { Pbkdf2PasswordHasher } from "@onelight/core";

/* The acceptance run's setup failed here, and only here, on every attempt:
     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
     supported (requested 600000).
   Workers caps a single deriveBits call. This is the regression test for it,
   and it has to run in this pool because node has no such cap. */
describe("password hashing in a Workers isolate", () => {
  it("hashes and verifies at the full iteration count", async () => {
    const hasher = new Pbkdf2PasswordHasher();
    const encoded = await hasher.hash("long-password-value");
    expect(encoded).toContain("i=600000");
    expect(await hasher.verify("long-password-value", encoded)).toBe(true);
    expect(await hasher.verify("wrong-password-value", encoded)).toBe(false);
  });
});
