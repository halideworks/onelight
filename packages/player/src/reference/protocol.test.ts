import { describe, expect, it } from "vitest";
import {
  MAX_OPEN_FRAMES,
  referenceFrameAtTimestamp,
  referenceTimestampIsExact,
  timestampForReferenceFrame,
  type ReferenceRate,
} from "./protocol.js";

const rates: ReferenceRate[] = [
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60, den: 1 },
  { num: 24_000, den: 1_001 },
  { num: 30_000, den: 1_001 },
  { num: 60_000, den: 1_001 },
];

describe("reference decoder protocol", () => {
  it("keeps the initial resource cap at exactly six frames", () => {
    expect(MAX_OPEN_FRAMES).toBe(6);
  });

  it("round-trips integer frames through WebCodecs microsecond timestamps", () => {
    for (const rate of rates)
      for (const firstTimestampUs of [0, 1_000_000, -500_000])
        for (const frame of [0, 1, 2, 17, 1001, 86_399]) {
          const timestamp = timestampForReferenceFrame(
            frame,
            firstTimestampUs,
            rate,
          );
          expect(
            referenceFrameAtTimestamp(timestamp, firstTimestampUs, rate),
            `${String(rate.num)}/${String(rate.den)} frame ${String(frame)}`,
          ).toBe(frame);
          expect(
            referenceTimestampIsExact(timestamp, frame, firstTimestampUs, rate),
          ).toBe(true);
        }
  });

  it("rejects timestamps that cannot name the claimed frame", () => {
    const rate = { num: 24_000, den: 1_001 };
    const timestamp = timestampForReferenceFrame(120, 0, rate);
    expect(referenceTimestampIsExact(timestamp + 20_000, 120, 0, rate)).toBe(
      false,
    );
  });

  it("rejects invalid rates and frame positions", () => {
    expect(() =>
      timestampForReferenceFrame(-1, 0, { num: 24, den: 1 }),
    ).toThrow(/non-negative/);
    expect(() => timestampForReferenceFrame(0, 0, { num: 0, den: 1 })).toThrow(
      /positive rational/,
    );
  });
});
