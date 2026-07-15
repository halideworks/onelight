import { describe, expect, it } from "vitest";
import {
  SEEK_POSITION_IN_FRAME,
  frameAtCurrentTime,
  frameAtMediaTime,
  frameDuration,
  mediaTimeInsideFrame,
  verifyFrame,
} from "./frame-clock.js";

const rates = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 30000, den: 1001 },
  { num: 60, den: 1 },
];

const boundary = (frame: number, rate: { num: number; den: number }): number =>
  (frame * rate.den) / rate.num;

describe("player frame clock", () => {
  it("uses rational frame rates and seeks inside the frame", () => {
    const rate = { num: 24000, den: 1001 };
    expect(frameAtMediaTime(boundary(1000, rate), rate)).toBe(1000);
    expect(mediaTimeInsideFrame(1000, rate)).toBeGreaterThan(
      boundary(1000, rate),
    );
    expect(verifyFrame(boundary(1000, rate), 1000, rate)).toBe(true);
  });

  it("reports frame duration as the rational reciprocal", () => {
    expect(frameDuration({ num: 24000, den: 1001 })).toBe(1001 / 24000);
    expect(frameDuration({ num: 24, den: 1 })).toBe(1 / 24);
    expect(frameDuration({ num: 60000, den: 1001 })).toBe(1001 / 60000);
  });

  it("rVFC variant rounds: presented times near a frame boundary map to the nearest frame", () => {
    for (const rate of rates) {
      const duration = frameDuration(rate);
      for (const frame of [1, 999, 86400]) {
        const edge = boundary(frame, rate);
        expect(frameAtMediaTime(edge + 0.1 * duration, rate)).toBe(frame);
        expect(frameAtMediaTime(edge - 0.1 * duration, rate)).toBe(frame);
        expect(frameAtMediaTime(edge - 0.6 * duration, rate)).toBe(frame - 1);
        expect(frameAtMediaTime(edge + 0.6 * duration, rate)).toBe(frame + 1);
      }
    }
  });

  it("currentTime variant floors: times inside a frame interval map to that frame", () => {
    for (const rate of rates) {
      const duration = frameDuration(rate);
      for (const frame of [1, 999, 86400]) {
        const edge = boundary(frame, rate);
        expect(frameAtCurrentTime(edge + 0.1 * duration, rate)).toBe(frame);
        expect(frameAtCurrentTime(edge + 0.9 * duration, rate)).toBe(frame);
        expect(frameAtCurrentTime(edge - 0.1 * duration, rate)).toBe(frame - 1);
        expect(frameAtCurrentTime(edge - 0.9 * duration, rate)).toBe(frame - 1);
      }
    }
  });

  it("currentTime variant absorbs floating point error at exact boundaries", () => {
    for (const rate of rates) {
      for (const frame of [0, 1, 1000, 107892]) {
        expect(frameAtCurrentTime(boundary(frame, rate), rate)).toBe(frame);
      }
    }
  });

  /* This is the invariant the seek position exists to hold, and it has to be
     checked against BOTH mappings. The title always claimed "both variants" but
     only frameAtCurrentTime was asserted -- which is exactly how a seek target
     that frameAtMediaTime read as N+1 went unnoticed. The two mappings disagree
     across the back half of a frame, so the seek must land where they agree. */
  it("seek targets land inside the target frame for both variants", () => {
    for (const rate of rates) {
      for (const frame of [0, 1, 1000, 86400]) {
        const target = mediaTimeInsideFrame(frame, rate);
        expect(frameAtCurrentTime(target, rate), `floor at ${frame}`).toBe(
          frame,
        );
        expect(frameAtMediaTime(target, rate), `round at ${frame}`).toBe(frame);
        // ...and the player's own check must accept the player's own seek target.
        expect(verifyFrame(target, frame, rate), `verify ${frame}`).toBe(true);
        const next = boundary(frame + 1, rate);
        expect(target).toBeGreaterThan(boundary(frame, rate));
        expect(target).toBeLessThan(next);
      }
    }
  });

  /* The midpoint is exactly where rounding flips, so it is the one spot a seek
     must not aim at. Guards the constant against a well-meaning "shouldn't this
     be the middle of the frame?". */
  it("aims clear of the midpoint, where the two mappings disagree", () => {
    expect(SEEK_POSITION_IN_FRAME).toBeLessThan(0.5);
    for (const rate of rates) {
      const midpoint = ((1000 + 0.5) * rate.den) / rate.num;
      expect(frameAtMediaTime(midpoint, rate)).toBe(1001); // the trap
      expect(frameAtCurrentTime(midpoint, rate)).toBe(1000);
      const target = mediaTimeInsideFrame(1000, rate);
      expect(frameAtMediaTime(target, rate)).toBe(
        frameAtCurrentTime(target, rate),
      );
    }
  });

  it("never returns negative frames", () => {
    const rate = { num: 24, den: 1 };
    expect(frameAtMediaTime(-1, rate)).toBe(0);
    expect(frameAtCurrentTime(-1, rate)).toBe(0);
  });
});
