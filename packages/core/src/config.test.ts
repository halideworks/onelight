import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  PUBLIC_URL: "http://localhost:3000",
  SECRET_KEY: "0123456789abcdef0123456789abcdef",
};

describe("config boolean env parsing", () => {
  for (const key of ["OIDC_AUTO_PROVISION", "TRUST_PROXY"] as const) {
    it(`parses ${key} strictly instead of coercing non-empty strings to true`, () => {
      expect(loadConfig({ ...base, [key]: "false" })[key]).toBe(false);
      expect(loadConfig({ ...base, [key]: "0" })[key]).toBe(false);
      expect(loadConfig({ ...base, [key]: "" })[key]).toBe(false);
      expect(loadConfig({ ...base })[key]).toBe(false);
      expect(loadConfig({ ...base, [key]: "true" })[key]).toBe(true);
      expect(loadConfig({ ...base, [key]: "1" })[key]).toBe(true);
      expect(() => loadConfig({ ...base, [key]: "garbage" })).toThrow();
      expect(() => loadConfig({ ...base, [key]: "yes" })).toThrow();
      expect(() => loadConfig({ ...base, [key]: "no" })).toThrow();
    });
  }

  it("keeps COOKIE_SECURE strict and derives the default from PUBLIC_URL", () => {
    expect(loadConfig({ ...base }).cookieSecure).toBe(false);
    expect(
      loadConfig({ ...base, PUBLIC_URL: "https://review.example.com" })
        .cookieSecure,
    ).toBe(true);
    expect(
      loadConfig({
        ...base,
        PUBLIC_URL: "https://review.example.com",
        COOKIE_SECURE: "false",
      }).cookieSecure,
    ).toBe(false);
    expect(loadConfig({ ...base, COOKIE_SECURE: "true" }).cookieSecure).toBe(
      true,
    );
    expect(() => loadConfig({ ...base, COOKIE_SECURE: "garbage" })).toThrow();
  });

  it("accepts an optional BLOB_ROOT", () => {
    expect(loadConfig({ ...base }).BLOB_ROOT).toBeUndefined();
    expect(loadConfig({ ...base, BLOB_ROOT: "/data/blobs" }).BLOB_ROOT).toBe(
      "/data/blobs",
    );
  });
});
