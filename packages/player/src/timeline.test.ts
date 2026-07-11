import { describe, expect, it } from "vitest";
import { frameAtCurrentTime, mediaTimeForFrameMiddle } from "./frame-clock.js";
import { frameForX, spanForRange, xForFrame } from "./timeline.js";

/* The timeline is frame-indexed, so the math is rate-independent, but the
   durations exercised here are real 24000/1001 material lengths and the
   round trips through the frame clock run at that rate. */
const RATE = { num: 24000, den: 1001 };

describe("timeline position math", () => {
  it("round-trips frame -> x -> frame for every frame of a short clip", () => {
    const duration = 500;
    for (const width of [200, 320.5, 977, 1920]) {
      for (let frame = 0; frame < duration; frame += 1) {
        expect(
          frameForX(xForFrame(frame, duration, width), duration, width),
        ).toBe(frame);
      }
    }
  });

  it("round-trips edge and interior frames of an hour of 23.976 material", () => {
    const duration = 86_314; /* one hour at 24000/1001, floor */
    for (const width of [640, 1287.25, 3840]) {
      for (const frame of [0, 1, 2, 43_157, duration - 2, duration - 1]) {
        expect(
          frameForX(xForFrame(frame, duration, width), duration, width),
        ).toBe(frame);
      }
    }
  });

  it("keeps frame centers strictly inside the track", () => {
    const duration = 2878;
    const width = 1000;
    expect(xForFrame(0, duration, width)).toBeGreaterThan(0);
    expect(xForFrame(duration - 1, duration, width)).toBeLessThan(width);
  });

  it("clamps x outside the track to the first and last frames", () => {
    const duration = 2878;
    const width = 640;
    expect(frameForX(-25, duration, width)).toBe(0);
    expect(frameForX(0, duration, width)).toBe(0);
    expect(frameForX(width, duration, width)).toBe(duration - 1);
    expect(frameForX(width + 25, duration, width)).toBe(duration - 1);
  });

  it("clamps out-of-range frames onto the track", () => {
    const duration = 100;
    const width = 500;
    expect(xForFrame(-5, duration, width)).toBe(xForFrame(0, duration, width));
    expect(xForFrame(1000, duration, width)).toBe(
      xForFrame(duration - 1, duration, width),
    );
  });

  it("returns 0 for degenerate tracks", () => {
    expect(xForFrame(10, 0, 500)).toBe(0);
    expect(xForFrame(10, 100, 0)).toBe(0);
    expect(frameForX(10, 0, 500)).toBe(0);
    expect(frameForX(10, 100, 0)).toBe(0);
  });

  it("timeline seeks land inside the target frame at 24000/1001", () => {
    const duration = 86_314;
    const width = 977;
    for (const x of [0, 0.4, width / 3, width / 2, width - 0.4, width]) {
      const frame = frameForX(x, duration, width);
      const seekTime = mediaTimeForFrameMiddle(frame, RATE);
      expect(frameAtCurrentTime(seekTime, RATE)).toBe(frame);
    }
  });

  it("computes range spans covering both endpoint frame slices", () => {
    const duration = 100;
    expect(spanForRange(0, 0, duration)).toEqual({ left: 0, width: 0.01 });
    expect(spanForRange(10, 19, duration)).toEqual({ left: 0.1, width: 0.1 });
    expect(spanForRange(99, 99, duration)).toEqual({ left: 0.99, width: 0.01 });
    /* Out-of-order and out-of-range inputs clamp instead of inverting. */
    expect(spanForRange(50, 20, duration).width).toBe(0.01);
    expect(spanForRange(-5, 500, duration)).toEqual({ left: 0, width: 1 });
    expect(spanForRange(1, 2, 0)).toEqual({ left: 0, width: 0 });
  });
});
