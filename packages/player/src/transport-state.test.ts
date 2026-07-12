import { describe, expect, it } from "vitest";
import { isVerifyStale, seeksLocked } from "./transport-state.js";

describe("draw-mode seek lock", () => {
  it("does not lock while no strokes are pending", () => {
    expect(seeksLocked(true, 0)).toBe(false);
    expect(seeksLocked(false, 0)).toBe(false);
  });

  it("locks seeks once a stroke is pending in draw mode", () => {
    expect(seeksLocked(true, 1)).toBe(true);
    expect(seeksLocked(true, 3)).toBe(true);
  });

  it("does not lock when strokes are pending but draw mode is off", () => {
    /* Pending strokes with the tool disarmed still render, but the anchor is
       fixed and the player is free to seek away from it. */
    expect(seeksLocked(false, 2)).toBe(false);
  });

  it("invariant: a seek attempted with a pending stroke is prevented", () => {
    /* Models the bug: draw on frame 100, then a Next/timeline seek fires. The
       lock must report true so the player refuses the seek and the anchor
       stays on 100. */
    const drawMode = true;
    const pendingStrokes = 1;
    const seekAllowed = !seeksLocked(drawMode, pendingStrokes);
    expect(seekAllowed).toBe(false);
  });
});

describe("seek verify generation", () => {
  it("applies a verify whose generation is still current", () => {
    expect(isVerifyStale(1, 1)).toBe(false);
  });

  it("bails a verify whose seek has been superseded", () => {
    expect(isVerifyStale(1, 2)).toBe(true);
  });

  it("invariant: two rapid seeks, the first verify must not override the second", () => {
    /* Fast scrub 10 -> 50: seekFrame(10) captures generation 1, seekFrame(50)
       captures generation 2 and becomes current. Both verifies fire on one
       presented frame. Generation 1 is stale and must stand down; generation 2
       is live and may re-seek to its own target. */
    let generation = 0;
    const firstGen = ++generation; // seekFrame(10)
    const secondGen = ++generation; // seekFrame(50)
    const current = generation;

    expect(isVerifyStale(firstGen, current)).toBe(true);
    expect(isVerifyStale(secondGen, current)).toBe(false);
  });
});
