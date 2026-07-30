/* ---- how a notification reads ----

   One vocabulary for every place a notification is described: the subject line,
   the email body, the plain text alternative. Kept here rather than in the mail
   sweep so the words are testable on their own and cannot drift between the
   subject and the body of the same message.

   The rule behind every string: name the person, name the thing, and say what
   happened, in that order, because that is the order the reader needs it.
   "Onelight: new comment" answers none of those questions. */

import type { EmailItem } from "./email.js";

export type NotificationKind =
  | "comment.created"
  | "comment.reply"
  | "comment.mention"
  | "approval.updated"
  | "transcode.failed"
  | "version.created";

export interface NotificationFacts {
  kind: string;
  payload: Record<string, unknown>;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

/** Frames as a timecode a person can type into a player. */
export const frameLabel = (frame: number, fps = 24): string => {
  const total = Math.max(0, Math.floor(frame));
  const rate = fps > 0 ? Math.round(fps) : 24;
  const seconds = Math.floor(total / rate);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}:${pad(total % rate)}`;
};

/* Both sentence forms per status, because a status change with a name on it
   reads differently from one without: "Dana approved it" against "it was
   approved". Written out rather than assembled from fragments, which is how
   you end up with "Dana sent back for changes SPOT_30". */
const APPROVAL_SENTENCES: Record<
  string,
  {
    byActor: (actor: string, asset: string) => string;
    passive: (asset: string) => string;
  }
> = {
  approved: {
    byActor: (actor, asset) => `${actor} approved ${asset}`,
    passive: (asset) => `${asset} was approved`,
  },
  changes_requested: {
    byActor: (actor, asset) => `${actor} asked for changes on ${asset}`,
    passive: (asset) => `${asset} needs changes`,
  },
  in_review: {
    byActor: (actor, asset) => `${actor} put ${asset} up for review`,
    passive: (asset) => `${asset} is up for review`,
  },
  none: {
    byActor: (actor, asset) => `${actor} cleared the status on ${asset}`,
    passive: (asset) => `${asset} has no status now`,
  },
};

/**
 * What to call this, in a sentence. `you` is the recipient's own name so a
 * mention can say "mentioned you" rather than repeating your name back at you.
 */
export const describeNotification = (
  row: NotificationFacts,
): { headline: string; tone: EmailItem["tone"]; quote?: string } => {
  const payload = row.payload;
  const actor = text(payload.actor_name);
  const asset = text(payload.asset_name) ?? "an asset";
  const preview = text(payload.preview);
  const who = actor ?? "Someone";
  switch (row.kind) {
    case "comment.mention":
      return {
        headline: `${who} mentioned you on ${asset}`,
        tone: "note",
        ...(preview ? { quote: preview } : {}),
      };
    case "comment.reply":
      return {
        headline: `${who} replied on ${asset}`,
        tone: "note",
        ...(preview ? { quote: preview } : {}),
      };
    case "comment.created":
      return {
        headline: `${who} commented on ${asset}`,
        tone: "note",
        ...(preview ? { quote: preview } : {}),
      };
    case "approval.updated": {
      const status = text(payload.status) ?? "none";
      const sentence = APPROVAL_SENTENCES[status];
      return {
        headline: sentence
          ? actor
            ? sentence.byActor(actor, asset)
            : sentence.passive(asset)
          : `${asset} is now ${status.replace(/_/g, " ")}`,
        tone: status === "changes_requested" ? "attention" : "good",
      };
    }
    case "transcode.failed":
      return {
        headline: `${asset} could not be processed`,
        tone: "attention",
        /* Why, when the worker managed to say why. Generic sympathy is what
           makes somebody mail support instead of fixing the export. */
        quote:
          text(payload.reason) ??
          "Onelight could not read this file. Re-upload it, or send a different export.",
      };
    case "version.created": {
      const versionNo = integer(payload.version_no);
      const which =
        versionNo === null ? "a new version" : `v${String(versionNo)}`;
      return {
        headline: actor
          ? `${actor} uploaded ${which} of ${asset}`
          : `${which} of ${asset} was uploaded`,
        tone: "quiet",
      };
    }
    default:
      return {
        headline: preview ?? `Something happened to ${asset}`,
        tone: "quiet",
      };
  }
};

/* ---- why a file would not open ----

   The worker's error text is written for a log: long, multi-line, and full of
   absolute paths inside the container, which are both meaningless to a reader
   and nobody's business outside. But "could not be processed" with no reason at
   all is the message that makes somebody mail support rather than re-export.

   So the common failures are recognised and given a sentence with a next step
   in it, and anything unrecognised is reduced to one short line with the paths
   taken out. */
const FAILURE_PATTERNS: Array<{ test: RegExp; reason: string }> = [
  {
    test: /does not contain any stream|invalid data found|moov atom not found/i,
    reason:
      "The file has no readable media in it, which usually means the transfer was cut short. Upload it again.",
  },
  {
    test: /no space left/i,
    reason:
      "The server ran out of disk while processing it. Nothing is wrong with the file; ask whoever runs this Onelight to make room, then upload it again.",
  },
  {
    test: /decoder \(codec|unknown codec|unsupported codec|no decoder for/i,
    reason:
      "Onelight cannot decode this codec. Export a ProRes, DNx or H.264 master and send that instead.",
  },
  {
    test: /permission denied/i,
    reason:
      "The server could not read the uploaded file. Upload it again; if it happens twice, this is a fault worth reporting.",
  },
  {
    test: /timed out|killed|signal 9/i,
    reason:
      "Processing ran too long and was stopped. A shorter export, or one at a lower resolution, will get through.",
  },
  {
    test: /pixel format|unsupported pixel/i,
    reason:
      "The picture is in a pixel format Onelight cannot read. Re-export it as 8 or 10 bit 4:2:2 or 4:4:4.",
  },
];

/** One short line, safe to show and worth reading. */
export const failureReason = (
  error: string | null | undefined,
): string | null => {
  if (!error) return null;
  const flat = error.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  for (const pattern of FAILURE_PATTERNS)
    if (pattern.test.test(flat)) return pattern.reason;
  /* Unrecognised: keep the worker's own words, but only the tail of any path
     and only as much as somebody will read. */
  const withoutPaths = flat.replace(/(?:\/[\w.@ +-]+){2,}/g, (match) => {
    const parts = match.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  });
  const clipped =
    withoutPaths.length > 180
      ? `${withoutPaths.slice(0, 179).trimEnd()}\u2026`
      : withoutPaths;
  return clipped || null;
};

/** The short noun for counting: "3 comments, 1 approval". */
export const notificationNoun = (kind: string, count: number): string => {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "comment.mention":
      return `${String(count)} mention${plural}`;
    case "comment.reply":
      return `${String(count)} repl${count === 1 ? "y" : "ies"}`;
    case "comment.created":
      return `${String(count)} comment${plural}`;
    case "approval.updated":
      return `${String(count)} approval${count === 1 ? "" : "s"}`;
    case "transcode.failed":
      return `${String(count)} failed upload${plural}`;
    case "version.created":
      return `${String(count)} new version${plural}`;
    default:
      return `${String(count)} update${plural}`;
  }
};

/* Which kinds matter most when there is only room to lead with one. A mention
   is addressed to you personally; a file that failed is blocking somebody; a
   version arriving is the quietest thing in the list. */
const KIND_WEIGHT: Record<string, number> = {
  "comment.mention": 5,
  "transcode.failed": 4,
  "approval.updated": 3,
  "comment.reply": 2,
  "comment.created": 1,
  "version.created": 0,
};

export const mostImportantKind = (kinds: string[]): string | null => {
  let best: string | null = null;
  let weight = -1;
  for (const kind of kinds) {
    const score = KIND_WEIGHT[kind] ?? 0;
    if (score > weight) {
      weight = score;
      best = kind;
    }
  }
  return best;
};

/* "3 comments and 1 approval", strongest kind first.

   Two clauses, not three: a subject line is cut off around sixty characters in
   most mailboxes, and the third clause is always the one nobody needed. What
   does not fit is counted as "N more updates", which is honest and short. */
export const countPhrase = (kinds: string[], clauses = 2): string => {
  const counts = new Map<string, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const ordered = [...counts.entries()].sort(
    (left, right) => (KIND_WEIGHT[right[0]] ?? 0) - (KIND_WEIGHT[left[0]] ?? 0),
  );
  const lead = ordered
    .slice(0, clauses)
    .map(([kind, count]) => notificationNoun(kind, count));
  const rest = ordered
    .slice(clauses)
    .reduce((sum, [, count]) => sum + count, 0);
  if (rest)
    lead.push(`${String(rest)} more ${rest === 1 ? "update" : "updates"}`);
  if (lead.length === 1) return lead[0] as string;
  return `${lead.slice(0, -1).join(", ")} and ${lead[lead.length - 1] as string}`;
};
