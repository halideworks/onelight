import type { FrameRate } from "@onelight/core";

export type PlayerCaptionCue = {
  startTime: number;
  endTime: number;
  text: string;
};

export const captionCuesAtFrame = (
  cues: readonly PlayerCaptionCue[],
  frame: number,
  rate: FrameRate,
): readonly PlayerCaptionCue[] => {
  if (
    !Number.isSafeInteger(frame) ||
    frame < 0 ||
    !Number.isSafeInteger(rate.num) ||
    rate.num <= 0 ||
    !Number.isSafeInteger(rate.den) ||
    rate.den <= 0
  )
    return [];
  const frameStart = (frame * rate.den) / rate.num;
  const frameEnd = ((frame + 1) * rate.den) / rate.num;
  return cues.filter(
    (cue) =>
      Number.isFinite(cue.startTime) &&
      Number.isFinite(cue.endTime) &&
      cue.startTime < frameEnd &&
      cue.endTime > frameStart,
  );
};
