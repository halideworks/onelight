/* The name two files share when one is a new version of the other.

   The complaint this exists for: "when we make updates to a batch, I think you
   have to drag the version 2s on top of the version 1s and it takes a lot of
   time". For 1200 files it is not a workflow, it is a day.

   What a second pass of the same picture is actually called, in the wild:

     IMG_0431.jpg          ->  IMG_0431_v2.jpg
     IMG_0431.jpg          ->  IMG_0431 (1).jpg          (a browser's copy)
     IMG_0431.jpg          ->  IMG_0431 copy 2.jpg       (Finder's copy)
     Poster.psd            ->  Poster_final.psd
     Day3-0087.tif         ->  Day3-0087-rev3.tif
     A001C002.jpg          ->  A001C002.tif              (a different format)

   So the key is the name with its extension, its version token and its
   separators taken off. Two rules make it safe to act on:

   1. A bare trailing number is NEVER stripped. IMG_0431 and IMG_0432 are two
      photographs, not two versions of one, and no amount of convenience is
      worth stacking a shoot on top of itself.
   2. A key that matches more than one asset is a conflict, not a match. The
      caller is told, and a human decides.

   Nothing here is applied automatically. The API offers the match, the
   uploader shows the count, and a person presses the button. */

/** Everything after the last dot, when that looks like an extension. */
const withoutExtension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  const extension = name.slice(dot + 1);
  /* A "." in the middle of a name is common (Day.03.0087); only a short
     alphanumeric tail is an extension. */
  return /^[a-z0-9]{1,5}$/i.test(extension) ? name.slice(0, dot) : name;
};

/* Tokens stripped from the end, repeatedly, longest-standing convention
   first. Each must be preceded by a separator or a bracket, so a name that
   simply ends in "v" or "final" as a word is left alone. */
const VERSION_TOKENS: RegExp[] = [
  /[ _.-]*\(\s*\d+\s*\)$/,
  /[ _.-]*copy(?:[ _.-]*\d+)?$/i,
  /[ _.-]+(?:v|ver|version|rev|revision)[ _.-]?\d+$/i,
  /[ _.-]+final(?:[ _.-]?\d+)?$/i,
];

/** The trailing version token, if the name carries one. */
export const versionTokenOf = (name: string): string | null => {
  const stem = withoutExtension(name);
  for (const pattern of VERSION_TOKENS) {
    const match = pattern.exec(stem);
    if (match) return match[0].replace(/^[ _.-]+/, "");
  }
  return null;
};

/** The identity two files share when one is a new version of the other. */
export const stackKeyOf = (name: string): string => {
  let stem = withoutExtension(name.trim());
  /* Repeated because a name can carry more than one: "shot_v2 copy 3". */
  for (let pass = 0; pass < 4; pass += 1) {
    const before = stem;
    for (const pattern of VERSION_TOKENS) stem = stem.replace(pattern, "");
    if (stem === before) break;
  }
  const key = stem
    .toLowerCase()
    /* Separators are noise: a delivery renamed from underscores to hyphens is
       the same delivery. */
    .replace(/[\s_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  /* Never empty: a file called "_v2.jpg" still has an identity, and an empty
     key would match every other empty one. */
  return (
    key ||
    withoutExtension(name.trim()).toLowerCase() ||
    name.trim().toLowerCase()
  );
};

/** How a candidate was matched, strongest first. */
export type StackMatchRule =
  "exact-name" | "stack-key" | "stack-key-in-folder" | "different-extension";

export const STACK_MATCH_STRENGTH: Record<StackMatchRule, number> = {
  "exact-name": 0,
  "stack-key-in-folder": 1,
  "stack-key": 2,
  "different-extension": 3,
};
