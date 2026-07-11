/* Normalized annotation geometry shared by the player and its consumers.
   Points are normalized to the displayed frame: x and y in [0, 1]. */

export type AnnotationPoint = [number, number, number?];

/* Stroke width convention: values below 1 are normalized fractions of the
   frame diagonal (what this player writes); values of 1 or more are legacy
   device pixels from earlier clients. Renderers must accept both. */
export type AnnotationStroke = {
  tool?: "pen" | "line" | "arrow" | "rect" | "ellipse";
  color?: string;
  width?: number;
  points: AnnotationPoint[];
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
