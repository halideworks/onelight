import { describe, expect, it } from "vitest";
import { generatedAvatarFor } from "./avatar.js";

describe("generated avatars", () => {
  it("returns the same identity for the same registered user", () => {
    expect(generatedAvatarFor("Ada Lovelace", "user-ada")).toEqual(
      generatedAvatarFor("Ada Lovelace", "user-ada"),
    );
  });

  it("uses the same name-only identity for public viewers", () => {
    expect(generatedAvatarFor("Grace Hopper")).toEqual(
      generatedAvatarFor("Grace Hopper"),
    );
  });

  it("uses the first Unicode character as the visible initial", () => {
    expect(generatedAvatarFor("  Élodie  ").initial).toBe("É");
    expect(generatedAvatarFor("   ").initial).toBe("?");
  });
});
