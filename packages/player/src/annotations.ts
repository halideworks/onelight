/* Normalized annotation geometry shared by the player and its consumers.
   Points are normalized to the displayed frame: x and y in [0, 1]. */

export type AnnotationPoint = [number, number, number?];

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
