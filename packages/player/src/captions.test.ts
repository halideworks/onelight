import { describe, expect, it } from "vitest";
import { captionCuesAtFrame, type PlayerCaptionCue } from "./captions.js";

const cues: PlayerCaptionCue[] = [
  { startTime: 1, endTime: 2, text: "one" },
  { startTime: 2, endTime: 3, text: "two" },
  { startTime: 2.5, endTime: 2.75, text: "overlap" },
];

describe("reference caption timing", () => {
  it("uses frame intervals without showing the preceding boundary cue", () => {
    expect(captionCuesAtFrame(cues, 24, { num: 24, den: 1 })).toEqual([
      cues[0],
    ]);
    expect(captionCuesAtFrame(cues, 48, { num: 24, den: 1 })).toEqual([
      cues[1],
    ]);
  });

  it("returns overlapping cues in source order", () => {
    expect(captionCuesAtFrame(cues, 60, { num: 24, den: 1 })).toEqual([
      cues[1],
      cues[2],
    ]);
  });

  it("supports exact rational rates and rejects invalid frame identity", () => {
    expect(
      captionCuesAtFrame([{ startTime: 10, endTime: 10.1, text: "ten" }], 240, {
        num: 24_000,
        den: 1_001,
      }),
    ).toHaveLength(1);
    expect(captionCuesAtFrame(cues, -1, { num: 24, den: 1 })).toEqual([]);
  });
});
