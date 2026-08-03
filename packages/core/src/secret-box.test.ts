import { describe, expect, it } from "vitest";
import { isSealed, open, openStored, seal } from "./secret-box.js";

const KEY = "a-deployment-secret-key-of-thirty-two-chars";

describe("a secret kept in the database", () => {
  it("comes back exactly as it went in", async () => {
    const password = "hunter2 with a space and ünïcode";
    const sealed = await seal(KEY, password);
    expect(await open(KEY, sealed)).toBe(password);
  });

  it("does not look like what it is", async () => {
    const sealed = await seal(KEY, "correct-horse-battery-staple");
    /* The whole point: a backup, a `.dump`, or a screenshot of the settings
       table shows this and not the password. */
    expect(sealed).not.toContain("correct-horse");
    expect(isSealed(sealed)).toBe(true);
  });

  it("seals the same secret differently every time", async () => {
    const first = await seal(KEY, "same password");
    const second = await seal(KEY, "same password");
    /* A fresh IV per write, so a reader of the column cannot tell that an
       admin re-saved the settings without changing the password. */
    expect(first).not.toBe(second);
    expect(await open(KEY, first)).toBe("same password");
    expect(await open(KEY, second)).toBe("same password");
  });

  it("will not open under a different key", async () => {
    const sealed = await seal(KEY, "hunter2");
    /* Null rather than a throw: the reachable cause is a rotated SECRET_KEY,
       which makes every sealed value unreadable at once, and the instance has
       to keep serving and say mail is unconfigured. */
    expect(await open("a-different-secret-key-entirely-here", sealed)).toBe(
      null,
    );
  });

  it("will not open a value somebody edited", async () => {
    const sealed = await seal(KEY, "hunter2");
    const [prefix, iv, body] = sealed.split(".");
    /* AES-GCM authenticates, so a flipped byte is a failure and not a
       different plaintext. */
    const tampered = `${prefix}.${iv}.${(body ?? "").slice(0, -2)}AA`;
    expect(await open(KEY, tampered)).toBe(null);
  });

  it("will not open something that is not sealed at all", async () => {
    expect(await open(KEY, "hunter2")).toBe(null);
    expect(isSealed("hunter2")).toBe(false);
    expect(isSealed("v1")).toBe(false);
  });

  describe("reading a column written before any of this existed", () => {
    it("returns plaintext as it is", async () => {
      /* Instances that stored a password before sealing existed keep working;
         the next write seals it. A migration could not do this -- the key
         lives in the environment, not in the database being migrated. */
      expect(await openStored(KEY, "an old plaintext password")).toBe(
        "an old plaintext password",
      );
    });

    it("opens a sealed one", async () => {
      expect(await openStored(KEY, await seal(KEY, "hunter2"))).toBe("hunter2");
    });

    it("treats absent and empty as nothing", async () => {
      expect(await openStored(KEY, null)).toBe(null);
      expect(await openStored(KEY, undefined)).toBe(null);
      expect(await openStored(KEY, "")).toBe(null);
    });
  });
});
