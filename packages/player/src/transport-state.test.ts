import { describe, expect, it } from "vitest";
import {
  applyMark,
  isRangeDrag,
  isVerifyStale,
  rangeFromClick,
  rangeFromDrag,
  rangeIsSet,
  seeksLocked,
} from "./transport-state.js";

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

describe("painting a range by click", () => {
  const empty = { in: null, out: null };

  it("plants the in on the first click", () => {
    expect(rangeFromClick(24, empty)).toEqual({ in: 24, out: null });
  });

  it("closes the range with a click after the in", () => {
    expect(rangeFromClick(96, { in: 24, out: null })).toEqual({
      in: 24,
      out: 96,
    });
  });

  it("moves the in when the click lands before it", () => {
    /* The rule David asked for: reaching backwards means the moment being
       described started earlier, not that an inverted range was wanted. */
    expect(rangeFromClick(10, { in: 24, out: null })).toEqual({
      in: 10,
      out: null,
    });
  });

  it("treats a click on the in itself as moving the in, not a zero range", () => {
    expect(rangeFromClick(24, { in: 24, out: null })).toEqual({
      in: 24,
      out: null,
    });
  });

  it("starts over once the range is closed", () => {
    expect(rangeFromClick(200, { in: 24, out: 96 })).toEqual({
      in: 200,
      out: null,
    });
  });

  it("invariant: no sequence of clicks produces an inverted range", () => {
    let range: { in: number | null; out: number | null } = empty;
    for (const at of [50, 20, 80, 10, 5, 300, 299, 1]) {
      range = rangeFromClick(at, range);
      if (range.in !== null && range.out !== null)
        expect(range.out).toBeGreaterThan(range.in);
    }
  });
});

describe("painting a range by drag", () => {
  it("reads a forward drag as in then out", () => {
    expect(rangeFromDrag(12, 90)).toEqual({ in: 12, out: 90 });
  });

  it("reads a backward drag the same way round", () => {
    /* The hand may travel either direction; the range is the same span. */
    expect(rangeFromDrag(90, 12)).toEqual({ in: 12, out: 90 });
  });

  it("needs real travel before a press counts as a drag", () => {
    expect(isRangeDrag(100, 101)).toBe(false);
    expect(isRangeDrag(100, 102)).toBe(false);
    expect(isRangeDrag(100, 103)).toBe(true);
    expect(isRangeDrag(100, 97)).toBe(true);
  });
});

describe("when a range is finished", () => {
  it("is unfinished until both ends exist", () => {
    expect(rangeIsSet({ in: null, out: null })).toBe(false);
    expect(rangeIsSet({ in: 10, out: null })).toBe(false);
    expect(rangeIsSet({ in: null, out: 10 })).toBe(false);
  });

  it("is unfinished while the out is not genuinely later", () => {
    expect(rangeIsSet({ in: 10, out: 10 })).toBe(false);
    expect(rangeIsSet({ in: 10, out: 9 })).toBe(false);
  });

  it("is finished once the out is past the in", () => {
    expect(rangeIsSet({ in: 10, out: 11 })).toBe(true);
  });
});
