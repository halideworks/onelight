/* Comment body segmentation for @mentions and #hashtags. Shared by the
   review page and the share page (imported relatively; both routes are
   review-room surfaces). Rendering stays plain text plus emphasis: the
   splitter never interprets markup.

   Hashtag grammar mirrors the server's extractHashtags in
   packages/api/src/helpers.ts: #[a-z0-9_]+, case-insensitive, lowercased. */

export type CommentSegment = {
  kind: "text" | "mention" | "tag";
  text: string;
  /* Lowercased tag without the #, present when kind is "tag". */
  tag?: string;
};

const TAG_PATTERN = /^[A-Za-z0-9_]+/;

/* Longest known member name matching at @; mention tokens are only
   recognized against real names so arbitrary @words stay plain text
   (falling back to a single word when no directory is available). */
const mentionMatch = (
  text: string,
  names: readonly string[],
): string | null => {
  let best: string | null = null;
  for (const name of names) {
    if (!name) continue;
    if (
      text.length >= name.length &&
      text.slice(0, name.length).toLowerCase() === name.toLowerCase()
    ) {
      if (best === null || name.length > best.length)
        best = text.slice(0, name.length);
    }
  }
  if (best) return best;
  const word = /^[A-Za-z0-9_.-]+/.exec(text);
  return word && names.length === 0 ? word[0] : null;
};

const boundaryBefore = (body: string, index: number): boolean =>
  index === 0 || /[\s([{]/.test(body[index - 1] ?? "");

export const segmentCommentBody = (
  body: string,
  memberNames: readonly string[] = [],
): CommentSegment[] => {
  const segments: CommentSegment[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      segments.push({ kind: "text", text: plain });
      plain = "";
    }
  };
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? "";
    if (char === "@" && boundaryBefore(body, index)) {
      const name = mentionMatch(body.slice(index + 1), memberNames);
      if (name) {
        flush();
        segments.push({ kind: "mention", text: `@${name}` });
        index += 1 + name.length;
        continue;
      }
    }
    if (char === "#" && boundaryBefore(body, index)) {
      const match = TAG_PATTERN.exec(body.slice(index + 1));
      if (match) {
        flush();
        segments.push({
          kind: "tag",
          text: `#${match[0]}`,
          tag: match[0].toLowerCase(),
        });
        index += 1 + match[0].length;
        continue;
      }
    }
    plain += char;
    index += 1;
  }
  flush();
  return segments;
};

/* Client-side fallback when a comment payload predates the derived tags
   field; same grammar as the server. */
export const hashtagsIn = (body: string): string[] => {
  const tags: string[] = [];
  for (const match of body.matchAll(/#([A-Za-z0-9_]+)/g)) {
    const tag = (match[1] ?? "").toLowerCase();
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
};
