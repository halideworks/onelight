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
  /* Stable identity for colouring: names collide and change, ids do not. */
  authorId?: string | null;
  /* A share-scoped or authenticated image URL. Missing images use initials. */
  avatarUrl?: string | null;
  /* The app's deterministic generated-avatar wash. It is supplied by the host
     because the player does not own the product palette. */
  generatedAvatarBackground?: string | null;
  text?: string | null;
  completed?: boolean;
};

/* Muted, desaturated, and R=G!=B only as far as the design doc allows: the
   review room bans tinted chrome near the frame but explicitly permits "muted
   desaturated functional colors" for markers. Ten hues, far enough apart to
   tell two people's notes apart at a glance on a 36px lane. */
export const MARKER_INKS = [
  "#7f9bb5",
  "#a58d76",
  "#8fa87e",
  "#a37f8f",
  "#7ea3a3",
  "#a89a7e",
  "#8e8bb0",
  "#a9877e",
  "#78a08c",
  "#9d9a86",
];

/* A stable index per author: the same person is the same colour on every
   reload and for every reviewer, which is the only reason the colour means
   anything. Unattributed notes fall to the last ink. */
export const markerInkFor = (authorId: string | null | undefined): string => {
  if (!authorId) return MARKER_INKS[MARKER_INKS.length - 1] as string;
  let hash = 0;
  for (let index = 0; index < authorId.length; index += 1)
    hash = (hash * 31 + authorId.charCodeAt(index)) >>> 0;
  return MARKER_INKS[hash % MARKER_INKS.length] as string;
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
