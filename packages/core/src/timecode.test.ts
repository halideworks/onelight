import { describe, expect, it } from "vitest";
import {
  formatTimecode,
  framesFromTimecode,
  parseTimecode,
  timecodeFromFrames,
  type FrameRate,
} from "./timecode.js";

const nominal = (rate: FrameRate): number => Math.round(rate.num / rate.den);

const roundTrip = (
  frame: number,
  rate: FrameRate,
  dropFrame: boolean,
): number =>
  framesFromTimecode(
    parseTimecode(
      formatTimecode(timecodeFromFrames(frame, rate, dropFrame)),
      rate,
    ),
    rate,
  );

// 24h has 1440 minutes, of which 144 (multiples of ten) keep their frames.
const dropFrameFramesPerDay = (rate: FrameRate): number =>
  24 * 3600 * nominal(rate) - (nominal(rate) === 30 ? 2 : 4) * 1296;

describe("timecode round-trip properties (P2-T05)", () => {
  it("round-trips every frame across 24 hours at 29.97 DF and 59.94 DF", () => {
    for (const rate of [
      { num: 30000, den: 1001 },
      { num: 60000, den: 1001 },
    ]) {
      const total = dropFrameFramesPerDay(rate);
      let firstMismatch = -1;
      for (let frame = 0; frame < total; frame += 1) {
        if (roundTrip(frame, rate, true) !== frame) {
          firstMismatch = frame;
          break;
        }
      }
      expect(firstMismatch).toBe(-1);
    }
  });

  // Boundary-dense NDF coverage: every frame of the first and last ten
  // minutes, plus frames around every minute boundary across 24 hours,
  // keeps CI time sane while hitting all carry positions.
  it("round-trips boundary-dense NDF coverage across 24 hours", () => {
    const ndfRates: FrameRate[] = [
      { num: 24000, den: 1001 },
      { num: 24, den: 1 },
      { num: 25, den: 1 },
      { num: 30000, den: 1001 },
      { num: 50, den: 1 },
      { num: 60, den: 1 },
    ];
    for (const rate of ndfRates) {
      const fps = nominal(rate);
      const total = 24 * 3600 * fps;
      const frames = new Set<number>();
      for (let frame = 0; frame < fps * 600; frame += 1) frames.add(frame);
      for (let frame = total - fps * 600; frame < total; frame += 1)
        frames.add(frame);
      for (let minute = 1; minute < 24 * 60; minute += 1) {
        const boundary = minute * 60 * fps;
        frames.add(boundary - 1);
        frames.add(boundary);
        frames.add(boundary + 1);
      }
      let firstMismatch = -1;
      for (const frame of frames) {
        if (roundTrip(frame, rate, false) !== frame) {
          firstMismatch = frame;
          break;
        }
      }
      expect(firstMismatch).toBe(-1);
    }
  });

  it("rejects dropped drop-frame labels at 29.97", () => {
    const rate = { num: 30000, den: 1001 };
    expect(() => parseTimecode("00:01:00;00", rate)).toThrow();
    expect(() => parseTimecode("00:01:00;01", rate)).toThrow();
    expect(() => parseTimecode("00:01:00;02", rate)).not.toThrow();
    expect(() => parseTimecode("00:10:00;00", rate)).not.toThrow();
  });

  it("rejects drop frame at 24 fps", () => {
    const rate = { num: 24, den: 1 };
    expect(() => timecodeFromFrames(0, rate, true)).toThrow();
    expect(() => parseTimecode("00:00:01;00", rate)).toThrow();
    expect(() =>
      framesFromTimecode(
        { hours: 0, minutes: 0, seconds: 1, frames: 0, dropFrame: true },
        rate,
      ),
    ).toThrow();
  });

  it("rejects unsupported rates", () => {
    for (const rate of [
      { num: 23, den: 1 },
      { num: 12, den: 1 },
      { num: 30000, den: 1000 },
    ]) {
      expect(() => timecodeFromFrames(0, rate)).toThrow();
      expect(() =>
        framesFromTimecode(
          { hours: 0, minutes: 0, seconds: 0, frames: 0, dropFrame: false },
          rate,
        ),
      ).toThrow();
    }
  });
});
