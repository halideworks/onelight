/* Timeline position math. The track maps frame indexes 0..durationFrames-1
   onto a horizontal span of `width` units (pixels or percent). Positions in
   data are integer frames; these helpers are the only place the timeline
   converts between frames and track coordinates. */

/* A comment marker on the timeline. frameOut > frameIn marks a range
   comment, which renders as a span instead of a point marker. */
export type TimelineMarker = {
  id: string;
  frameIn: number;
  frameOut?: number | null;
  author?: string | null;
  text?: string | null;
  completed?: boolean;
};

/* Track x for the center of a frame. Each frame owns an equal slice of the
   track; the playhead and point markers sit at the slice center so frame 0
   and the last frame stay visibly inside the track. */
export const xForFrame = (
  frame: number,
  durationFrames: number,
  width: number,
): number => {
  if (durationFrames <= 0 || width <= 0) return 0;
  const clamped = Math.min(Math.max(frame, 0), durationFrames - 1);
  return ((clamped + 0.5) / durationFrames) * width;
};

/* Frame whose slice contains x. Clamped so any x maps to a valid frame:
   x <= 0 is frame 0 and x >= width is the last frame. Inverse of xForFrame
   for every frame index (floor(frame + 0.5) is exact in float for any frame
   count a review asset can have). */
export const frameForX = (
  x: number,
  durationFrames: number,
  width: number,
): number => {
  if (durationFrames <= 0 || width <= 0) return 0;
  const fraction = Math.min(Math.max(x / width, 0), 1);
  return Math.min(durationFrames - 1, Math.floor(fraction * durationFrames));
};

/* Left edge and width of a frame range as fractions of the track, covering
   the full slices of both endpoint frames (a one-frame range still has
   visible width). */
export const spanForRange = (
  frameIn: number,
  frameOut: number,
  durationFrames: number,
): { left: number; width: number } => {
  if (durationFrames <= 0) return { left: 0, width: 0 };
  const first = Math.min(Math.max(frameIn, 0), durationFrames - 1);
  const last = Math.min(Math.max(frameOut, first), durationFrames - 1);
  return {
    left: first / durationFrames,
    width: (last - first + 1) / durationFrames,
  };
};
