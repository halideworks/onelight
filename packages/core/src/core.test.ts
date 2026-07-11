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

  it("creates and verifies the portable PBKDF2 password format", async () => {
    const hasher = new Pbkdf2PasswordHasher();
    const encoded = await hasher.hash("long-password-value");
    expect(encoded).toMatch(/^\$pbkdf2-sha256\$i=100000\$/);
    await expect(hasher.verify("long-password-value", encoded)).resolves.toBe(
      true,
    );
    await expect(hasher.verify("wrong-password-value", encoded)).resolves.toBe(
      false,
    );
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
