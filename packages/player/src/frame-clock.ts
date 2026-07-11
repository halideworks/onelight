import type { FrameRate } from "@onelight/core";

/* Frame identity from an rVFC presented mediaTime. The presented time sits
   inside the frame interval, so nearest-integer mapping is correct here. */
export const frameAtMediaTime = (mediaTime: number, rate: FrameRate): number =>
  Math.max(0, Math.round((mediaTime * rate.num) / rate.den));

/* Frame identity from HTMLMediaElement.currentTime on the non-rVFC fallback
   path. currentTime reports the playhead position, not a presented frame, so
   the mapping floors into the frame interval. The epsilon absorbs floating
   point error at exact frame boundaries. */
export const frameAtCurrentTime = (
  currentTime: number,
  rate: FrameRate,
): number =>
  Math.max(0, Math.floor((currentTime * rate.num) / rate.den + 1e-6));

export const mediaTimeForFrameMiddle = (
  frame: number,
  rate: FrameRate,
): number => ((frame + 0.5) * rate.den) / rate.num;

export const frameDuration = (rate: FrameRate): number => rate.den / rate.num;

export const verifyFrame = (
  mediaTime: number,
  expectedFrame: number,
  rate: FrameRate,
): boolean => frameAtMediaTime(mediaTime, rate) === expectedFrame;
