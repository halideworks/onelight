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

/* ---- keys the operating system must not press for you ----

   Holding a key makes the OS repeat it, tens of times a second, at a rate the
   person sets in their own system preferences. For a key that STEPS that is
   the point: hold the left arrow and walk back through the footage.

   For a key that ESCALATES it is a bug, and it was this one. Every L doubles
   the shuttle, so resting on L for a moment does not play at speed one, it
   runs to four in about a tenth of a second -- fast enough that the reviewer
   never sees the 1x or the 2x go by, and far enough that the audio is no
   longer something you can listen to. It reproduced for one person and not
   another because the two of them have different key-repeat settings, and it
   followed them across browsers and across operating systems because it was
   never the browser doing it.

   The same goes for anything that toggles: an auto-repeated F would enter and
   leave fullscreen thirty times a second.

   A deliberate second press still doubles the shuttle, which is what J and L
   are for. This only refuses the presses the person did not make. */
export function ignoresAutoRepeat(key: string): boolean {
  return [
    "j",
    "l",
    "k",
    " ",
    "spacebar",
    "i",
    "o",
    "x",
    "p",
    "f",
    "m",
    "d",
  ].includes(key.toLowerCase());
}

/* ---- painting a range on the timeline ----

   The keyboard sets marks one at a time (I, then O). The pointer paints a
   whole range, and it has to do it without a second bar to drag on: the same
   strip both scrubs and marks, so the gesture is armed first (by asking for a
   ranged note, or by asking to loop with nothing marked) and disarms itself
   the moment a range exists. Alt is the shortcut past the arming step for
   people who already know.

   A press that never moves is a click, and a click is where the intelligence
   lives: the first one plants the in, one after it closes the range, and one
   before it moves the in rather than making an inverted range nobody meant.
   Reaching backwards is how someone realises the moment they were describing
   started earlier than they thought. */
export type Range = { in: number | null; out: number | null };

export function rangeFromClick(at: number, current: Range): Range {
  /* Nothing planted yet, or the previous range is closed and this click starts
     a new one: this is an in, and any old out goes with the old in. */
  if (current.in === null || current.out !== null) return { in: at, out: null };
  /* An in is planted and open. Past it closes the range; at it or before it
     moves the in, because a zero-length or inverted range is not a thing
     anyone is asking for. */
  return at > current.in ? { in: current.in, out: at } : { in: at, out: null };
}

/* A drag names both ends at once, in whichever direction the hand went. */
export function rangeFromDrag(anchor: number, at: number): Range {
  return { in: Math.min(anchor, at), out: Math.max(anchor, at) };
}

/* Whether a pointer gesture that started at `anchor` and ended at `at` counts
   as a drag rather than a click. One frame of travel is not intent; on a long
   timeline a single pixel can be many frames, so the threshold is in pixels
   and the caller measures it there. */
export function isRangeDrag(anchorX: number, x: number): boolean {
  return Math.abs(x - anchorX) >= 3;
}

/* A range is only usable once both ends exist and the out is genuinely later.
   Arming ends here: the gesture disarms itself rather than staying live and
   eating the next scrub. */
export function rangeIsSet(range: Range): boolean {
  return range.in !== null && range.out !== null && range.out > range.in;
}
