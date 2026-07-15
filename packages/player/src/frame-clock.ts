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

/* Where inside a frame's interval a seek aims.

   Not the middle, and the quarter is load-bearing. The two frame mappings here
   disagree about what to do with a time inside a frame: frameAtMediaTime rounds
   to the nearest boundary (rVFC reports a presented frame's PTS, which can
   arrive a hair early, so rounding snaps it back), while frameAtCurrentTime
   floors (currentTime is a playhead position, so the frame is the one
   containing it). Those two agree everywhere except the second half of the
   interval -- and the exact midpoint, 0.5, is where rounding flips to N+1.

   Seeking to the midpoint therefore put the seek target on the one value the
   two mappings answer differently. That was invisible until a browser echoed
   the seek position back through rVFC instead of the frame's PTS (Firefox does,
   intermittently), at which point round(N+0.5) = N+1 and the readout ran a
   frame ahead of the picture -- and notes anchored to that frame. verifyFrame
   rejected its own seek target for the same reason.

   A quarter in is unambiguous: round(N+0.25) and floor(N+0.25) are both N. The
   seek still lands well inside the frame, clear of both boundaries, so neither
   mapping has to change and the identity contract is untouched. */
export const SEEK_POSITION_IN_FRAME = 0.25;

export const mediaTimeInsideFrame = (frame: number, rate: FrameRate): number =>
  ((frame + SEEK_POSITION_IN_FRAME) * rate.den) / rate.num;

export const frameDuration = (rate: FrameRate): number => rate.den / rate.num;

export const verifyFrame = (
  mediaTime: number,
  expectedFrame: number,
  rate: FrameRate,
): boolean => frameAtMediaTime(mediaTime, rate) === expectedFrame;
