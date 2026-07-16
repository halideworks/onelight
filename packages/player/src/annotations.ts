/* Normalized annotation geometry shared by the player and its consumers.
   Points are normalized to the displayed frame: x and y in [0, 1]. */

export type AnnotationPoint = [number, number, number?];

/* Stroke width convention: values below 1 are normalized fractions of the
   frame diagonal (what this player writes); values of 1 or more are legacy
   device pixels from earlier clients. Renderers must accept both. */
export type AnnotationStroke = {
  tool?: "pen" | "line" | "arrow" | "rect" | "ellipse" | "text";
  color?: string;
  width?: number;
  points: AnnotationPoint[];
  /* Only the text tool carries this; points[0] anchors the first character's
     baseline start. width keeps its convention (a fraction of the frame
     diagonal) and sets the type size. */
  text?: string;
};

/* A set of strokes anchored to an integer frame (a comment's frame_in).
   Strokes render only while the playhead sits on that exact frame. */
export type FrameAnnotation = {
  frame: number | null;
  strokes: AnnotationStroke[];
};

/* An uncommitted drawing made in the player, anchored to the frame that was
   current when drawing started. Hosts attach it to a new comment as
   annotation_json in the object form { strokes: [...] }. Readers must keep
   accepting the legacy bare stroke array form; the object form is what the
   API's wire mapper passes through, so it is the only form written. */
export type PendingDrawing = {
  frame: number;
  strokes: AnnotationStroke[];
};

/* Drawing inks, bright siblings of the timeline's MARKER_INKS: same ten
   positions, same author hash, so the colour a person draws in matches the
   colour their markers wear. Bright, because these sit on footage rather
   than on a 36px lane. */
export const ANNOTATION_INKS = [
  "#6aa5d8",
  "#d8a069",
  "#8fca6a",
  "#d477a2",
  "#5fc4c4",
  "#d8bc5f",
  "#9a95e0",
  "#d88a6a",
  "#5fc490",
  "#c4c48a",
];

export const annotationInkFor = (author: string | null | undefined): string => {
  if (!author) return ANNOTATION_INKS[ANNOTATION_INKS.length - 1] as string;
  let hash = 0;
  for (let index = 0; index < author.length; index += 1)
    hash = (hash * 31 + author.charCodeAt(index)) >>> 0;
  return ANNOTATION_INKS[hash % ANNOTATION_INKS.length] as string;
};
