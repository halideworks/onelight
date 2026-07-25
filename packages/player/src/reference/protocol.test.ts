import { describe, expect, it } from "vitest";
import {
  decodeOutputIsOutOfOrder,
  decodeWindowIsComplete,
  MAX_DECODE_REORDER,
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

  /* WebKit emits one frame per fed packet in the order fed, so a B-frame
     stream arrives shuffled: measured on our own proxies, a frame can run
     three ahead and two behind its place in the stream. */
  it("tolerates codec reordering but not a decoder that lost the thread", () => {
    expect(decodeOutputIsOutOfOrder(7, null)).toBe(false);
    expect(decodeOutputIsOutOfOrder(9, 7)).toBe(false);
    expect(decodeOutputIsOutOfOrder(5, 7)).toBe(false);
    expect(decodeOutputIsOutOfOrder(40 - MAX_DECODE_REORDER, 40)).toBe(false);
    expect(decodeOutputIsOutOfOrder(40 - MAX_DECODE_REORDER - 1, 40)).toBe(
      true,
    );
  });

  it("calls a window complete only when every one of its frames is accounted for", () => {
    const held = new Set([10, 11, 13, 14, 15]);
    // 12 is still to come: a frame past the end arriving first proves nothing.
    expect(decodeWindowIsComplete(10, 15, (frame) => held.has(frame))).toBe(
      false,
    );
    held.add(12);
    expect(decodeWindowIsComplete(10, 15, (frame) => held.has(frame))).toBe(
      true,
    );
    // An empty range is trivially complete: the window ended before it began.
    expect(decodeWindowIsComplete(10, 9, () => false)).toBe(true);
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
