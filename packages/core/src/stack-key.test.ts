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

describe("a post house's naming", () => {
  it("treats a leading date and time as the version, not the identity", () => {
    /* DATE_TIME_TIMELINE: tomorrow's pass of the same timeline is the same
       timeline. This is the convention the whole tier exists for. */
    const monday = stackKeyOf("20260729_1515_jonmusicvideo.mov");
    expect(monday).toBe("jonmusicvideo");
    for (const name of [
      "20260730_0930_jonmusicvideo.mov",
      "2026-07-30_0930_jonmusicvideo.mov",
      "20260730T0930_jonmusicvideo.mov",
      "20260730 0930 jonmusicvideo.mov",
      "20260730_jonmusicvideo.mov",
      "20260730_093015_jonmusicvideo.mov",
    ])
      expect(stackKeyOf(name), name).toBe(monday);
  });

  it("strips a version token in the middle, point release and all", () => {
    /* A real deliverable name: the version sits in the middle and the rest
       says which cut-down it is, which is NOT something to collapse. */
    const a = stackKeyOf(
      "WorldCup_Argentina_v5.58_BR_US_EN_30s_1080x1920_MP4_YTShorts_Organic.mp4",
    );
    const b = stackKeyOf(
      "WorldCup_Argentina_v5.59_BR_US_EN_30s_1080x1920_MP4_YTShorts_Organic.mp4",
    );
    const c = stackKeyOf(
      "WorldCup_Argentina_v6_BR_US_EN_30s_1080x1920_MP4_YTShorts_Organic.mp4",
    );
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).not.toContain("v5");
    /* A different deliverable of the same spot is a different asset: the
       1080x1920 Shorts cut and the master are not versions of each other. */
    expect(
      stackKeyOf(
        "WorldCup_Argentina_v5.58_BR_US_EN_30s_1080x1920_Master_Owned.mov",
      ),
    ).not.toBe(a);
    /* And a different spot is a different spot. */
    expect(
      stackKeyOf(
        "WorldCup_Spain_v31_BR_US_EN_30s_1080x1920_MP4_YTShorts_Organic.mp4",
      ),
    ).not.toBe(a);
  });

  it("leaves a date that is not a release stamp alone", () => {
    /* A date in the middle or at the end is part of the name. Stripping it
       would fold a whole day of shooting into one identity. */
    expect(stackKeyOf("DSC_20260729.jpg")).not.toBe(
      stackKeyOf("DSC_20260730.jpg"),
    );
    expect(stackKeyOf("shoot_20260729_final.jpg")).toContain("20260729");
    /* And a number that is not date-shaped is never a stamp. */
    expect(stackKeyOf("0431_hero.jpg")).not.toBe(stackKeyOf("0432_hero.jpg"));
    expect(stackKeyOf("20261345_1515_name.mov")).toContain("20261345");
  });

  it("keeps a word that merely starts with v or contains a version-ish run", () => {
    expect(stackKeyOf("Revenant_trailer.mov")).toBe("revenant-trailer");
    expect(stackKeyOf("level7_boss.mov")).toBe("level7-boss");
    expect(stackKeyOf("v2_only.mov")).toBe("v2-only");
  });

  it("still refuses to collapse a numbered sequence", () => {
    /* The rule the whole matcher rests on, restated against the new
       stripping: a shoot is a run of numbered frames. */
    expect(stackKeyOf("A001C002_20260729.mov")).not.toBe(
      stackKeyOf("A001C003_20260729.mov"),
    );
    expect(stackKeyOf("20260729_1515_shot_001.mov")).not.toBe(
      stackKeyOf("20260729_1515_shot_002.mov"),
    );
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
