import type {
  AnnotationStroke,
  FrameAnnotation,
  TimelineMarker,
} from "@onelight/player";
import { generatedAvatarFor } from "@onelight/core";
import { washFor } from "./washes.js";

/* The comment fields the review room and the share room share: enough to
   render annotations, timeline markers, and the note body. Each page extends
   this with its own extra columns (version_id, parent_id, and so on). */
export type CommentAttachment = {
  id: string;
  filename: string;
  size: number;
  content_type: string;
};

export type ReviewComment = {
  id: string;
  author_name: string | null;
  author_user_id?: string | null;
  author_avatar_url?: string | null;
  body_text: string;
  frame_in: number | null;
  frame_out: number | null;
  completed_at: number | null;
  tags?: string[];
  annotation: unknown;
  /* Present on list reads; a freshly created comment has none yet. */
  attachments?: CommentAttachment[];
};

/* Annotation payloads come from clients we do not control: accept either a
   bare stroke array or { strokes: [...] } and drop anything malformed. */
export const strokesFrom = (annotation: unknown): AnnotationStroke[] => {
  const candidates = Array.isArray(annotation)
    ? annotation
    : annotation &&
        typeof annotation === "object" &&
        Array.isArray((annotation as { strokes?: unknown }).strokes)
      ? (annotation as { strokes: unknown[] }).strokes
      : [];
  return candidates.filter(
    (stroke): stroke is AnnotationStroke =>
      typeof stroke === "object" &&
      stroke !== null &&
      Array.isArray((stroke as { points?: unknown }).points),
  );
};

/* Frame-anchored strokes for the player overlay: one entry per commented
   frame that actually carries valid strokes. */
export const annotationsFrom = (comments: ReviewComment[]): FrameAnnotation[] =>
  comments
    .filter((comment) => comment.frame_in !== null && comment.annotation)
    .map((comment) => ({
      frame: comment.frame_in,
      strokes: strokesFrom(comment.annotation),
    }))
    .filter((annotation) => annotation.strokes.length > 0);

/* Timeline markers for every frame-anchored comment. */
export const markersFrom = (comments: ReviewComment[]): TimelineMarker[] =>
  comments
    .filter((comment) => comment.frame_in !== null)
    .map((comment) => {
      /* Share viewers have no id on the public wire, so their name stands in
         and stays stable per viewer. This is also the seed used by Avatar. */
      const authorId = comment.author_user_id ?? comment.author_name ?? null;
      const generated = generatedAvatarFor(
        comment.author_name ?? "Reviewer",
        authorId,
      );
      return {
        id: comment.id,
        frameIn: comment.frame_in as number,
        frameOut: comment.frame_out,
        author: comment.author_name,
        authorId,
        avatarUrl: comment.author_avatar_url ?? null,
        generatedAvatarBackground: washFor(generated.palette),
        text: comment.body_text,
        completed: comment.completed_at !== null,
      };
    });
