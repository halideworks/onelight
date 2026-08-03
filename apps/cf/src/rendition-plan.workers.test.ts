import { describe, expect, it } from "vitest";
import {
  CLIP_HASH_POSITIONS,
  planRenditions,
  primaryRenditionKinds,
  STILL_FULL_RUNG,
  STILL_LADDER,
} from "@onelight/core";

/* The gate for mounting the job protocol on this target.
 *
 * Deciding which renditions a version should have used to live in
 * `@onelight/worker`, whose index re-exports `media.ts`, and `media.ts` imports
 * `node:child_process` on its first line. Importing any of it here does not
 * report a missing module: workerd takes SIGSEGV and the pool dies with
 * "Worker exited unexpectedly", so there is no error to read and no partial
 * path to lean on.
 *
 * These names are the ones the server's claim needs. This file exists so that
 * moving one of them back behind the media graph fails here, in the runtime
 * that cannot load it, rather than at the end of the phase that depends on it.
 */
describe("the rendition plan, in a runtime with no processes", () => {
  it("decides a video ladder", () => {
    const planned = planRenditions("video", {
      format: {},
      streams: [{ codec_type: "video", width: 1920 }],
      variableFrameRate: false,
      colorAssumed: true,
    });
    expect(planned.map((entry) => entry.kind)).toEqual([
      "proxy_1080",
      "proxy_540",
      "poster",
      "sprite",
    ]);
  });

  it("decides a 4K ladder and reads HDR off the source", () => {
    const planned = planRenditions("video", {
      format: {},
      streams: [
        {
          codec_type: "video",
          width: 3840,
          color_transfer: "smpte2084",
        },
      ],
      variableFrameRate: false,
      colorAssumed: true,
    });
    const kinds = planned.map((entry) => entry.kind);
    expect(kinds).toContain("proxy_2160");
    /* The HDR pair is the part that reads the source's transfer rather than
       its size, so it proves the predicate came along and still decides. */
    expect(kinds).toContain("hdr_av1");
    expect(kinds).toContain("hdr_hevc");
  });

  it("carries the still ladder and the clip hash grid", () => {
    expect(primaryRenditionKinds("image")).toEqual([
      "still_review",
      "poster",
      "still_tiles",
    ]);
    expect(STILL_LADDER.map((rung) => rung.kind)).toEqual([
      "poster",
      "still_review",
    ]);
    expect(STILL_FULL_RUNG.longEdge).toBe(0);
    expect(CLIP_HASH_POSITIONS).toHaveLength(16);
    /* Both ends avoided, which is the whole point of the grid. */
    expect(CLIP_HASH_POSITIONS[0]).toBeGreaterThan(0);
    expect(CLIP_HASH_POSITIONS[15]).toBeLessThan(1);
  });
});
