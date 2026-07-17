/* Pure transport-state decisions for the review player.

   These helpers hold the small invariants that the player's imperative event
   handlers are easy to get wrong on: they are extracted so they can be tested
   directly, and Player.svelte calls them rather than re-deriving the rule
   inline. Frame identity is always integer frames; nothing here reads
   currentTime. */

/* A seek must not move the drawing anchor while a drawing is armed with at
   least one committed stroke: the pending strokes are already anchored to the
   frame they were drawn on, and seeking would silently re-anchor them to a
   different frame's pixels. While this is true the player blocks user seeks
   (Previous/Next, timeline scrub, marker jumps). */
export function seeksLocked(
  drawMode: boolean,
  pendingStrokeCount: number,
): boolean {
  return drawMode && pendingStrokeCount > 0;
}

/* Each seek captures the live generation counter. A one-shot rVFC verify
   closes over the generation it was queued at; it must stand down once a newer
   seek has superseded it, so a stale verify from an earlier fast-scrub target
   cannot re-seek the playhead backwards after the pointer settles. */
export function isVerifyStale(
  capturedGeneration: number,
  currentGeneration: number,
): boolean {
  return capturedGeneration !== currentGeneration;
}

/* Setting a mark never leaves an inverted range. The mark just set is the one
   the operator means, so a conflicting opposite mark clears: an in at or past
   the out drops the out, an out at or before the in drops the in. A range of
   zero frames is also meaningless for a loop, hence <= rather than <. */
export function applyMark(
  kind: "in" | "out",
  at: number,
  inFrame: number | null,
  outFrame: number | null,
): { in: number | null; out: number | null } {
  if (kind === "in")
    return {
      in: at,
      out: outFrame !== null && outFrame <= at ? null : outFrame,
    };
  return { in: inFrame !== null && inFrame >= at ? null : inFrame, out: at };
}
