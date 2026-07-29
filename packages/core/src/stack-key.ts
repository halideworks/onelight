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
  /[ _.-]+(?:v|ver|version|rev|revision)[ _.-]?\d+(?:\.\d+)*$/i,
  /[ _.-]+final(?:[ _.-]?\d+)?$/i,
];

/* And a version token in the MIDDLE of a name, which is where post-production
   actually puts it: WorldCup_Argentina_v5.58_BR_US_EN_30s_1080x1920.mp4 is one
   deliverable and v5.59 is the next pass of the same one. The delimiters on
   both sides are required, so a word like "Level7" or "Revenant" survives, and
   the point release is part of the token: v5.58 and v5.6 are both versions,
   not a version and a number. */
const INNER_VERSION_TOKEN =
  /([ _.-])(?:v|ver|version|rev|revision)[ _.-]?\d+(?:\.\d+)*(?=[ _.-])/gi;

/* A release stamp: the date, and optionally the time, that a post house puts
   at the FRONT of an export. 20260729_1515_jonmusicvideo.mov is the 15:15 pass
   of jonmusicvideo, and tomorrow's pass of the same timeline is the same
   thing under a new stamp, which is exactly what a version is.

   Only at the front, and this matters. A date anywhere else is part of the
   name (DSC_20260729.jpg is one frame, and stripping its date would fold a
   whole day's shooting into one identity), and a bare number is never a date
   at all: the token has to be date-shaped and has to parse as a plausible
   one. */
const LEADING_STAMP =
  /^(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _.tT-]+(\d{2})[-_.:]?(\d{2})(?:[-_.:]?(\d{2}))?)?(?=[ _.-])/;

const plausibleDate = (year: number, month: number, day: number): boolean =>
  year >= 1990 &&
  year <= 2100 &&
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= 31;

/** The date and time a name is stamped with, when it carries one at the front. */
export const releaseStampOf = (name: string): string | null => {
  const match = LEADING_STAMP.exec(name.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (
    !plausibleDate(Number(year), Number(month), Number(day)) ||
    (hour !== undefined && Number(hour) > 23) ||
    (minute !== undefined && Number(minute) > 59)
  )
    return null;
  return `${year}-${month}-${day}${
    hour === undefined ? "" : `T${hour}:${minute}${second ? `:${second}` : ""}`
  }`;
};

const withoutLeadingStamp = (stem: string): string => {
  if (!releaseStampOf(stem)) return stem;
  const stripped = stem.replace(LEADING_STAMP, "").replace(/^[ _.-]+/, "");
  /* A name that is nothing but its stamp keeps the stamp: the date is then
     the only identity the file has. */
  return stripped.trim() ? stripped : stem;
};

/** The version token a name carries, wherever it sits, or its release stamp
    when the stamp is what tells two passes apart. */
export const versionTokenOf = (name: string): string | null => {
  const stem = withoutExtension(name);
  for (const pattern of VERSION_TOKENS) {
    const match = pattern.exec(stem);
    if (match) return match[0].replace(/^[ _.-]+/, "");
  }
  const inner = new RegExp(INNER_VERSION_TOKEN.source, "i").exec(stem);
  if (inner) return inner[0].replace(/^[ _.-]+/, "");
  return releaseStampOf(stem);
};

/** The identity two files share when one is a new version of the other. */
export const stackKeyOf = (name: string): string => {
  let stem = withoutLeadingStamp(withoutExtension(name.trim()));
  stem = stem.replace(INNER_VERSION_TOKEN, "$1");
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
