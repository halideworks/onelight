import { describe, expect, it } from "vitest";
import { stackKeyOf, versionTokenOf } from "./stack-key.js";

describe("stackKeyOf", () => {
  it("ignores the extension, so a retouch delivered as a TIFF still matches", () => {
    expect(stackKeyOf("A001C002.jpg")).toBe(stackKeyOf("A001C002.tif"));
    expect(stackKeyOf("A001C002.jpg")).toBe(stackKeyOf("A001C002.psd"));
  });

  it("ignores case and separator style", () => {
    expect(stackKeyOf("IMG_0431.JPG")).toBe(stackKeyOf("img-0431.jpg"));
    expect(stackKeyOf("Day 3 0087.tif")).toBe(stackKeyOf("day_3_0087.tif"));
  });

  it("strips the version tokens a second pass actually arrives with", () => {
    const base = stackKeyOf("IMG_0431.jpg");
    for (const name of [
      "IMG_0431_v2.jpg",
      "IMG_0431-v02.jpg",
      "IMG_0431 v3.jpg",
      "IMG_0431_rev2.jpg",
      "IMG_0431_revision4.jpg",
      "IMG_0431 (1).jpg",
      "IMG_0431 copy.jpg",
      "IMG_0431 copy 2.jpg",
      "IMG_0431_final.jpg",
      "IMG_0431_final2.jpg",
      "IMG_0431_v2 copy.jpg",
    ])
      expect(stackKeyOf(name), name).toBe(base);
  });

  it("NEVER strips a bare trailing number", () => {
    /* The whole thing falls over if it does: a shoot is a run of numbered
       frames, and stacking IMG_0432 onto IMG_0431 destroys a delivery. */
    expect(stackKeyOf("IMG_0431.jpg")).not.toBe(stackKeyOf("IMG_0432.jpg"));
    expect(stackKeyOf("IMG_0431.jpg")).not.toBe(stackKeyOf("IMG_04310.jpg"));
    expect(stackKeyOf("shot-1.jpg")).not.toBe(stackKeyOf("shot-2.jpg"));
    expect(stackKeyOf("A001C002.jpg")).not.toBe(stackKeyOf("A001C003.jpg"));
  });

  it("keeps names that merely end in a version-ish word apart", () => {
    expect(stackKeyOf("final.jpg")).not.toBe(stackKeyOf("finality.jpg"));
    expect(stackKeyOf("groovy.jpg")).toBe("groovy");
    expect(stackKeyOf("cover.jpg")).toBe("cover");
  });

  it("keeps a dotted name whole", () => {
    /* "03" is not an extension; the name is Day.03.0087. */
    expect(stackKeyOf("Day.03.0087.tif")).toBe("day-03-0087");
    expect(stackKeyOf("Day.03.0088.tif")).not.toBe(
      stackKeyOf("Day.03.0087.tif"),
    );
  });

  it("never returns an empty key", () => {
    for (const name of ["_v2.jpg", "(1).png", "copy.psd", " .tif", "x"])
      expect(stackKeyOf(name).length, name).toBeGreaterThan(0);
  });

  it("is stable under repetition", () => {
    const once = stackKeyOf("Poster_final_v2 copy 3.psd");
    expect(stackKeyOf(`${once}.psd`)).toBe(once);
  });
});

describe("versionTokenOf", () => {
  it("names the token it found, for the line the UI shows", () => {
    expect(versionTokenOf("IMG_0431_v2.jpg")).toBe("v2");
    expect(versionTokenOf("IMG_0431 copy 2.jpg")).toBe("copy 2");
    expect(versionTokenOf("IMG_0431 (1).jpg")).toBe("(1)");
    expect(versionTokenOf("IMG_0431.jpg")).toBeNull();
    expect(versionTokenOf("IMG_0432.jpg")).toBeNull();
  });
});
