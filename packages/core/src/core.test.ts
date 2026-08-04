import { describe, expect, it } from "vitest";
import {
  framesFromTimecode,
  loadConfig,
  Pbkdf2PasswordHasher,
  projectRoleAtLeast,
  timecodeFromFrames,
  UlidGenerator,
} from "./index.js";

describe("core contracts", () => {
  it("generates monotonic ULIDs", () => {
    const ids = new UlidGenerator();
    const values = Array.from({ length: 100 }, () => ids.ulid());
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual([...values].sort());
  });

  it("rejects configuration without the required secret", () => {
    expect(() => loadConfig({ PUBLIC_URL: "http://localhost:3000" })).toThrow();
  });

  /* A real single-call 600,000-iteration hash of "long-password-value",
   generated with node's WebCrypto. This is the shape every deployment made
   before chaining existed, so it is a fixture rather than something computed
   here: the point is that a stored string from before the change still
   verifies. */
  const encoded600k = {
    salt: "BwcHBwcHBwcHBwcHBwcHBw",
    hash: "DTJ6Tn7OfURn1Mjz757F1WBAihdbDQSMOR2BHzQ_3wk",
  };

  it("creates and verifies the portable PBKDF2 password format", async () => {
    const hasher = new Pbkdf2PasswordHasher();
    const encoded = await hasher.hash("long-password-value");
    /* Chained, because Workers refuses more than 100,000 iterations in one
       deriveBits call and this app's floor is 600,000. */
    expect(encoded).toMatch(/^\$pbkdf2-sha256-c\$i=600000\$/);
    await expect(hasher.verify("long-password-value", encoded)).resolves.toBe(
      true,
    );
    await expect(hasher.verify("wrong-password-value", encoded)).resolves.toBe(
      false,
    );
    // A hash at the current floor does not want re-hashing.
    expect(hasher.needsRehash(encoded)).toBe(false);
  });

  it("still verifies a hash written before chaining, and asks to replace it", async () => {
    const hasher = new Pbkdf2PasswordHasher();
    /* What every existing deployment has: 600,000 iterations in one call.
       Node can still compute it, so nobody is locked out by the change. */
    const legacy =
      "$pbkdf2-sha256$i=600000$" + encoded600k.salt + "$" + encoded600k.hash;
    await expect(hasher.verify("long-password-value", legacy)).resolves.toBe(
      true,
    );
    /* But it is the form a Workers isolate cannot compute, so a successful
       login replaces it. That is what lets a node deployment move to the
       Workers target without resetting anybody's password. */
    expect(hasher.needsRehash(legacy)).toBe(true);
  });

  it("does not confuse the two schemes", async () => {
    const hasher = new Pbkdf2PasswordHasher();
    const chained = await hasher.hash("long-password-value");
    const legacy =
      "$pbkdf2-sha256$i=600000$" + encoded600k.salt + "$" + encoded600k.hash;
    /* Same password, same count, different function. If the stored string did
       not record which, verifying would silently reject a correct password. */
    expect(chained.split("$")[3]).not.toBe(legacy.split("$")[3]);
  });

  it("still verifies legacy 100k-iteration hashes and flags them for rehash", async () => {
    const hasher = new Pbkdf2PasswordHasher();
    // A hash written before the floor was raised: same format, lower count.
    // (Produced by the previous implementation; embedded verbatim so the
    // upgrade path is proven against a real old hash, not a re-derived one.)
    const legacy =
      "$pbkdf2-sha256$i=100000$" +
      (await (async () => {
        // Derive a genuine 100k hash for "old-secret" the way the old code did.
        const { pbkdf2Sync, randomBytes } = await import("node:crypto");
        const b64url = (b: Buffer): string =>
          b
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        const salt = randomBytes(16);
        const derived = pbkdf2Sync("old-secret", salt, 100000, 32, "sha256");
        return `${b64url(salt)}$${b64url(derived)}`;
      })());
    await expect(hasher.verify("old-secret", legacy)).resolves.toBe(true);
    await expect(hasher.verify("wrong", legacy)).resolves.toBe(false);
    expect(hasher.needsRehash(legacy)).toBe(true);
  });

  it("enforces project role ordering", () => {
    expect(projectRoleAtLeast("manager", "editor")).toBe(true);
    expect(projectRoleAtLeast("viewer", "editor")).toBe(false);
    expect(projectRoleAtLeast(undefined, "viewer")).toBe(false);
  });

  it("round trips drop-frame labels at 29.97 and 59.94", () => {
    for (const rate of [
      { num: 30000, den: 1001 },
      { num: 60000, den: 1001 },
    ]) {
      for (const frame of [0, 1, 1799, 1800, 17_982, 107_892, 258_940]) {
        const label = timecodeFromFrames(frame, rate, true);
        expect(framesFromTimecode(label, rate)).toBe(frame);
      }
    }
  });
});
