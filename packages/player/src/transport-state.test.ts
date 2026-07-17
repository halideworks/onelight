import { describe, expect, it } from "vitest";
import { applyMark, isVerifyStale, seeksLocked } from "./transport-state.js";

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

describe("mark ordering", () => {
  it("keeps a coherent range when marks are set in order", () => {
    expect(applyMark("in", 10, null, null)).toEqual({ in: 10, out: null });
    expect(applyMark("out", 50, 10, null)).toEqual({ in: 10, out: 50 });
  });

  it("setting an in at or past the out drops the out", () => {
    /* Models the found bug: out at 34, then I pressed at 44 left the readout
       showing out before in. The fresh in wins; the stale out clears. */
    expect(applyMark("in", 44, null, 34)).toEqual({ in: 44, out: null });
    expect(applyMark("in", 34, null, 34)).toEqual({ in: 34, out: null });
  });

  it("setting an out at or before the in drops the in", () => {
    expect(applyMark("out", 20, 40, null)).toEqual({ in: null, out: 20 });
    expect(applyMark("out", 40, 40, 90)).toEqual({ in: null, out: 40 });
  });

  it("re-marking on the valid side leaves the other mark alone", () => {
    expect(applyMark("in", 5, 10, 50)).toEqual({ in: 5, out: 50 });
    expect(applyMark("out", 90, 10, 50)).toEqual({ in: 10, out: 90 });
  });
});
