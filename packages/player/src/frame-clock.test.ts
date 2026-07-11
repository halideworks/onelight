import { describe, expect, it } from "vitest";
import {
  frameAtCurrentTime,
  frameAtMediaTime,
  frameDuration,
  mediaTimeForFrameMiddle,
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
  it("uses rational frame rates and middle-of-frame seeks", () => {
    const rate = { num: 24000, den: 1001 };
    expect(frameAtMediaTime(boundary(1000, rate), rate)).toBe(1000);
    expect(mediaTimeForFrameMiddle(1000, rate)).toBeGreaterThan(
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

  it("middle-of-frame seek targets land inside the target frame for both variants", () => {
    for (const rate of rates) {
      for (const frame of [0, 1, 1000, 86400]) {
        const middle = mediaTimeForFrameMiddle(frame, rate);
        expect(frameAtCurrentTime(middle, rate)).toBe(frame);
        const next = boundary(frame + 1, rate);
        expect(middle).toBeGreaterThan(boundary(frame, rate));
        expect(middle).toBeLessThan(next);
      }
    }
  });

  it("never returns negative frames", () => {
    const rate = { num: 24, den: 1 };
    expect(frameAtMediaTime(-1, rate)).toBe(0);
    expect(frameAtCurrentTime(-1, rate)).toBe(0);
  });
});
