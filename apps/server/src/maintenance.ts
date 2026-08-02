import fsSync from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  UlidGenerator,
  countPhrase,
  describeNotification,
  mailHeaders,
  unsubscribeToken,
  frameLabel,
  renderEmail,
} from "@onelight/core";
import type { BlobStore, EmailItem, MultipartBlobStore } from "@onelight/core";
import { LocalBlobStore } from "@onelight/worker";
import {
  assetVersions,
  assets,
  auditLog,
  captionTracks,
  commentAttachments,
  comments,
  exportJobs,
  notificationPreferences,
  notifications,
  workspaces,
  projectCoverUploads,
  projects,
  renditions,
  shares,
  uploadParts,
  uploadSessions,
  users,
} from "@onelight/db/schema";
import type { AppDb } from "@onelight/db";
import type { Mailer } from "./mailer.js";

const DAY_MS = 24 * 60 * 60_000;

/** How often the maintenance loop wakes up. */
const SWEEP_INTERVAL_MS = 60_000;
/** Unmailed notifications examined per sweep. */
export const EMAIL_SWEEP_LIMIT = 200;
/** Stale upload sessions reaped per sweep. */
export const UPLOAD_REAP_LIMIT = 50;
/** Trashed assets purged per sweep (versions have the same bound). */
export const TRASH_PURGE_LIMIT = 25;
/** Orphan keys listed individually in the GC log before summarizing. */
const GC_LOG_LIMIT = 200;
/** Orphans younger than this are never deleted, even with GC delete on. */
export const GC_ORPHAN_MIN_AGE_MS = DAY_MS;
/**
 * emailed_at value for rows that were skipped rather than sent (no mailer,
 * or the user has no address). Non-null so the sweep never rescans them.
 */
export const EMAIL_SENTINEL_AT = 0;

export const HOURLY_WINDOW_MS = 60 * 60_000;
export const DAILY_WINDOW_MS = DAY_MS;

export const DEFAULT_UPLOAD_REAP_AFTER_MS = 7 * DAY_MS;
export const DEFAULT_TRASH_PURGE_AFTER_MS = 30 * DAY_MS;
export const DEFAULT_GC_INTERVAL_MS = DAY_MS;

export interface MaintenanceConfig {
  publicUrl: string;
  /* Signs the one-click unsubscribe links in outgoing mail. The same secret the
     API signs them with, because the API is what has to verify them. */
  secretKey?: string;
  blobStore: BlobStore;
  uploadReapAfterMs: number;
  trashPurgeAfterMs: number;
  gcIntervalMs: number;
  gcDelete: boolean;
  /* Where DB snapshots live, if backups are on. The GC reads their manifests
     so a blob any retained snapshot references is never swept -- otherwise the
     GC could delete a blob out from under a backup you might restore. */
  backupDir?: string;
}

/**
 * Retention windows come from loadConfig, which validates them against the
 * manifest: a malformed TRASH_PURGE_AFTER_MS fails at startup instead of
 * becoming a silent 30 days.
 */
export const maintenanceConfigFromConfig = (
  config: {
    uploadReapAfterMs: number;
    trashPurgeAfterMs: number;
    gcIntervalMs: number;
    gcDelete: boolean;
    backupDir?: string | undefined;
  },
  base: { publicUrl: string; secretKey?: string; blobStore: BlobStore },
): MaintenanceConfig => {
  const backupDir = (config.backupDir ?? "").trim();
  return {
    publicUrl: base.publicUrl,
    ...(base.secretKey !== undefined ? { secretKey: base.secretKey } : {}),
    blobStore: base.blobStore,
    uploadReapAfterMs: config.uploadReapAfterMs,
    trashPurgeAfterMs: config.trashPurgeAfterMs,
    gcIntervalMs: config.gcIntervalMs,
    gcDelete: config.gcDelete,
    ...(backupDir ? { backupDir } : {}),
  };
};

const warn = (message: string): void => console.warn(`[onelight] ${message}`);
const log = (message: string): void => console.log(`[onelight] ${message}`);
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseObjectJson = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    groups.push(items.slice(index, index + size));
  return groups;
};

// ---------------------------------------------------------------------------
// Email notification sweep (pure planning, injected mailer and clock).
// ---------------------------------------------------------------------------

export type NotificationMode = "off" | "instant" | "hourly" | "daily";

/* What this reader wants for this KIND of news: their rule for it if they set
   one, otherwise their default. A mention arriving instantly and a new version
   waiting for the morning is the shape people actually want, and one dial
   cannot express it. */
export const modeForRow = (row: SweepNotificationRow): NotificationMode => {
  try {
    const overrides = JSON.parse(row.kindModesJson ?? "{}") as Record<
      string,
      unknown
    >;
    const chosen = overrides[row.kind];
    if (
      chosen === "off" ||
      chosen === "instant" ||
      chosen === "hourly" ||
      chosen === "daily"
    )
      return chosen;
  } catch {
    /* Unreadable preferences fall back to the default rather than failing. */
  }
  return row.mode;
};

/* Whether it is the hour they asked for, in their own day. Without this a
   "daily" summary arrives whenever the oldest unread row happened to land,
   which is not a habit anybody can build around. */
export const atDigestHour = (
  now: number,
  digestHour: number,
  utcOffsetMinutes: number,
): boolean => {
  const local = new Date(now + utcOffsetMinutes * 60_000);
  return local.getUTCHours() === digestHour;
};

export interface SweepNotificationRow {
  id: string;
  userId: string;
  kind: string;
  payloadJson: string;
  createdAt: number;
  email: string;
  mode: NotificationMode;
  /** Per-kind overrides, as stored: {"comment.mention":"instant"}. */
  kindModesJson?: string;
  /** Which hour of the reader's own day a daily summary should arrive. */
  digestHour?: number;
  /** Minutes east of UTC, so that hour is theirs and not the server's. */
  utcOffsetMinutes?: number;
  /** When their last daily summary went out. */
  lastDailyDigestAt?: number | null;
  /** Whose workspace this is, shown small at the top of the message. */
  workspaceName?: string;
  /** Signed, so a one-click unsubscribe works with no session. */
  unsubscribeToken?: string;
}

export interface PlannedEmail {
  to: string;
  subject: string;
  text: string;
  /** The HTML alternative; the text above is sent with it, never replaced. */
  html: string;
  /** Threading, unsubscribe and auto-reply suppression. */
  headers: Record<string, string>;
  notificationIds: string[];
}

export interface EmailSweepPlan {
  emails: PlannedEmail[];
  /** Rows to sentinel-mark because the user has no email address. */
  skippedIds: string[];
  /* Who was sent a daily summary, so the caller can stamp them. The hour gate
     is a clock rather than an age: without a stamp the sweep would send a fresh
     summary on every pass through that hour. */
  dailyUserIds: string[];
}

/* A subject line that means something on its own.

   The old one was the kind's name with a colon in front of it: "Onelight: new
   comment". Every message about every project in every workspace looked
   identical in a mailbox, which is the same as having no subject at all. Now
   the subject IS the news, and where there is more than one piece of news it is
   the count and the project. */
export const subjectForRow = (row: SweepNotificationRow): string => {
  const payload = parseObjectJson(row.payloadJson);
  const { headline } = describeNotification({ kind: row.kind, payload });
  const project =
    typeof payload.project_name === "string" ? payload.project_name : "";
  return project ? `${headline} - ${project}` : headline;
};

/** Kept for callers that only have a kind. The row form is the good one. */
export const subjectForKind = (kind: string): string =>
  describeNotification({ kind, payload: {} }).headline;

/**
 * Deep link into the app for a notification payload. Requires project_id
 * and asset_id; appends ?f=<frame> when the payload carries an integer
 * frame position.
 */
export const notificationDeepLink = (
  publicUrl: string,
  payload: Record<string, unknown>,
): string | null => {
  const projectId =
    typeof payload.project_id === "string" ? payload.project_id : null;
  const assetId =
    typeof payload.asset_id === "string" ? payload.asset_id : null;
  if (!projectId || !assetId) return null;
  const base = `${publicUrl.replace(/\/+$/, "")}/projects/${projectId}/assets/${assetId}`;
  const frame =
    typeof payload.frame === "number" && Number.isInteger(payload.frame)
      ? payload.frame
      : null;
  return frame === null ? base : `${base}?f=${frame}`;
};

const trimmedUrl = (publicUrl: string): string => publicUrl.replace(/\/+$/, "");

/* Where it happened, on one line: the project, the asset, and the timecode if
   the note is pinned to a frame. This is the line that tells somebody with four
   jobs running which of them this is about, which the old mail never did.

   What the line above it already said is left out: repeating the asset name
   directly under "Dana commented on SPOT_30_v3" is the padding that makes a
   digest twice as long as it needs to be. */
const metaLine = (
  payload: Record<string, unknown>,
  omit: { project?: boolean; asset?: boolean } = {},
): string | undefined => {
  const parts: string[] = [];
  const project =
    typeof payload.project_name === "string" ? payload.project_name : "";
  if (project && !omit.project) parts.push(project);
  const asset =
    typeof payload.asset_name === "string" ? payload.asset_name : "";
  if (asset && !omit.asset) parts.push(asset);
  if (typeof payload.frame === "number" && Number.isInteger(payload.frame))
    parts.push(`at ${frameLabel(payload.frame)}`);
  return parts.length ? parts.join(" \u00b7 ") : undefined;
};

const itemFor = (
  publicUrl: string,
  row: SweepNotificationRow,
  omit: { project?: boolean; asset?: boolean } = {},
): EmailItem => {
  const payload = parseObjectJson(row.payloadJson);
  const described = describeNotification({ kind: row.kind, payload });
  const link = notificationDeepLink(publicUrl, payload);
  const meta = metaLine(payload, omit);
  return {
    headline: described.headline,
    ...(described.tone ? { tone: described.tone } : {}),
    ...(described.quote ? { quote: described.quote } : {}),
    ...(meta ? { meta } : {}),
    ...(link ? { href: link } : {}),
  };
};

/* How much of a digest is worth sending. Past a dozen items nobody is reading
   any more, and a digest that scrolls is one people learn to archive unread. */
const DIGEST_ITEM_LIMIT = 12;

const footerFor = (publicUrl: string, reason: string): string[] => [
  reason,
  /* Where to answer, said out loud. There is no inbound mail here, so a reply
     goes nowhere: better to say so than to let somebody type a note into the
     void and wonder why nobody saw it. */
  "Replies to this message are not read. Answer in Onelight so the note lands on the frame.",
  `Choose what Onelight emails you, and when: ${trimmedUrl(publicUrl)}/settings/notifications`,
];

/* The unsubscribe URL a mail client will POST to on one click. */
const unsubscribeUrlFor = (
  publicUrl: string,
  token: string | undefined,
): string | undefined =>
  token
    ? `${trimmedUrl(publicUrl)}/api/v1/notifications/unsubscribe?t=${encodeURIComponent(token)}`
    : undefined;

/* What thread this belongs to. Keyed on the asset, so every note about one cut
   arrives as one conversation rather than as nine unrelated messages. */
const threadKeyFor = (payload: Record<string, unknown>): string | undefined =>
  typeof payload.asset_id === "string" && payload.asset_id
    ? `asset-${payload.asset_id}`
    : undefined;

const instantEmail = (
  publicUrl: string,
  row: SweepNotificationRow,
  workspace: string,
): PlannedEmail => {
  const payload = parseObjectJson(row.payloadJson);
  const item = itemFor(publicUrl, row);
  const link = item.href ?? trimmedUrl(publicUrl);
  const sentence =
    item.headline ?? describeNotification({ kind: row.kind, payload }).headline;
  const document = renderEmail({
    subject: subjectForRow(row),
    /* The inbox shows this next to the subject, so it carries what was said
       rather than "view in browser". */
    preheader: item.quote ?? item.meta ?? sentence,
    heading: sentence,
    ...(workspace ? { workspace } : {}),
    /* The heading above the card is already the sentence, so inside it there is
       only where this happened and what was said. No second headline, and no
       per-item link: the button below is the one action. */
    sections: [
      {
        items: [
          {
            ...(item.meta ? { meta: item.meta } : {}),
            ...(item.quote ? { quote: item.quote } : {}),
            ...(item.tone ? { tone: item.tone } : {}),
          },
        ],
      },
    ],
    action: { label: "Open it in Onelight", href: link },
    footer: footerFor(
      publicUrl,
      row.kind === "comment.mention"
        ? "You were sent this because you were mentioned."
        : "You were sent this because you are on this project.",
    ),
  });
  return {
    to: row.email,
    subject: document.subject,
    text: document.text,
    html: document.html,
    headers: mailHeaders({
      publicUrl,
      messageKey: `note-${row.id}`,
      threadKey: threadKeyFor(payload),
      unsubscribeUrl: unsubscribeUrlFor(publicUrl, row.unsubscribeToken),
    }),
    notificationIds: [row.id],
  };
};

const digestEmail = (
  publicUrl: string,
  rows: SweepNotificationRow[],
  workspace: string,
): PlannedEmail => {
  const first = rows[0] as SweepNotificationRow;
  const kinds = rows.map((row) => row.kind);
  /* Grouped by project, newest first inside each, because "which job" is the
     first question and a flat list of fifteen lines answers it last. */
  const groups = new Map<
    string,
    { name: string; named: boolean; rows: SweepNotificationRow[] }
  >();
  for (const row of rows) {
    const payload = parseObjectJson(row.payloadJson);
    const id = typeof payload.project_id === "string" ? payload.project_id : "";
    const name =
      typeof payload.project_name === "string" && payload.project_name
        ? payload.project_name
        : "";
    const group = groups.get(id) ?? {
      name: name || "Elsewhere in Onelight",
      named: name.length > 0,
      rows: [],
    };
    group.rows.push(row);
    groups.set(id, group);
  }
  const ordered = [...groups.values()].sort(
    (left, right) => right.rows.length - left.rows.length,
  );
  let budget = DIGEST_ITEM_LIMIT;
  const sections = [];
  for (const group of ordered) {
    if (budget <= 0) break;
    const take = group.rows.slice(0, budget);
    budget -= take.length;
    sections.push({
      /* One project needs no heading: the subject already said which. */
      ...(ordered.length > 1 ? { title: group.name } : {}),
      /* The headline names the asset and, where there is more than one job,
         the section heading names the project. Neither is worth saying twice,
         so what is left under each line is the timecode and nothing else. */
      items: take.map((row) =>
        itemFor(publicUrl, row, { asset: true, project: ordered.length > 1 }),
      ),
    });
  }
  const shown = DIGEST_ITEM_LIMIT - budget;
  const hidden = rows.length - shown;
  const phrase = countPhrase(kinds);
  /* "3 comments on Nike Spring" when there is one job to name, "...across 3
     projects" when there are several, and just the count when the rows carry no
     project name to stand behind. A subject must never invent a place. */
  const single = ordered.length === 1 ? ordered[0] : undefined;
  const subject = single
    ? single.named
      ? `${phrase} on ${single.name}`
      : phrase
    : `${phrase} across ${String(ordered.length)} projects`;
  const lead = itemFor(publicUrl, first);
  const document = renderEmail({
    subject,
    preheader: lead.quote ?? lead.headline ?? subject,
    /* The subject carries "across 2 projects" because an inbox has no other
       context; the heading does not, because the sections below it are the
       projects, named. */
    heading: single ? subject : phrase,
    ...(workspace ? { workspace } : {}),
    sections,
    ...(hidden > 0
      ? {
          more: `And ${String(hidden)} more ${hidden === 1 ? "update" : "updates"}, waiting in Onelight.`,
        }
      : {}),
    action: { label: "Open Onelight", href: trimmedUrl(publicUrl) },
    footer: footerFor(
      publicUrl,
      modeForRow(first) === "daily"
        ? "Your daily summary of the projects you are on."
        : "Your hourly summary of the projects you are on.",
    ),
  });
  return {
    to: first.email,
    subject: document.subject,
    text: document.text,
    html: document.html,
    /* A digest is its own message, not a reply to one of the notes in it: it
       gets an id and no thread, so it never buries a conversation. */
    headers: mailHeaders({
      publicUrl,
      messageKey: `digest-${first.userId}-${String(rows.length)}-${String(first.createdAt)}`,
      unsubscribeUrl: unsubscribeUrlFor(publicUrl, first.unsubscribeToken),
    }),
    notificationIds: rows.map((row) => row.id),
  };
};

/**
 * Pure planner for one email sweep. Instant mode sends one email per row.
 * Hourly and daily modes send one digest per user, but only once the user's
 * oldest unmailed row is older than the window; until then their rows stay
 * unmailed and are re-examined next sweep. Rows without a recipient address
 * are returned as skipped so the caller can sentinel-mark them.
 */
export const planEmailSweep = (
  rows: SweepNotificationRow[],
  now: number,
  publicUrl: string,
  workspace = "",
): EmailSweepPlan => {
  const emails: PlannedEmail[] = [];
  const skippedIds: string[] = [];
  const dailyUserIds: string[] = [];
  const byUser = new Map<string, SweepNotificationRow[]>();
  for (const row of rows) {
    if (!row.email.trim()) {
      skippedIds.push(row.id);
      continue;
    }
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }
  for (const userRows of byUser.values()) {
    const first = userRows[0] as SweepNotificationRow;
    /* Whose workspace, from the rows themselves where the query provided it,
       so a message says which studio it came from without the caller having
       to know. */
    const name = first.workspaceName ?? workspace;
    /* Routed per row, because one person can want a mention now and a version
       in the morning. The buckets are then sent on their own terms. */
    const instant: SweepNotificationRow[] = [];
    const hourly: SweepNotificationRow[] = [];
    const daily: SweepNotificationRow[] = [];
    for (const row of userRows) {
      const mode = modeForRow(row);
      /* Off means no email, ever, for this kind. The row is marked so it is
         not examined again; it is still in the app, where it was always the
         primary copy. */
      if (mode === "off") skippedIds.push(row.id);
      else if (mode === "instant") instant.push(row);
      else if (mode === "hourly") hourly.push(row);
      else daily.push(row);
    }
    for (const row of instant) emails.push(instantEmail(publicUrl, row, name));
    for (const [bucket, windowMs] of [
      [hourly, HOURLY_WINDOW_MS],
      [daily, DAILY_WINDOW_MS],
    ] as const) {
      if (!bucket.length) continue;
      const oldest = Math.min(...bucket.map((row) => row.createdAt));
      /* Hourly paces itself off the oldest unmailed row. Daily does not: it is
         a habit at a time of day, so its gate is the clock below. */
      if (windowMs === HOURLY_WINDOW_MS && now - oldest < windowMs) continue;
      /* A daily summary waits for the hour they asked for, unless it has been
         waiting so long that holding it again would be losing it. */
      if (windowMs === DAILY_WINDOW_MS) {
        const hour = first.digestHour ?? 8;
        const offset = first.utcOffsetMinutes ?? 0;
        /* Once a day, at the hour they asked for. Overdue is the escape for a
           server that was asleep at that hour: two days of silence is worse
           than a summary at the wrong time. */
        const overdue = now - oldest >= DAILY_WINDOW_MS * 2;
        const sentToday =
          first.lastDailyDigestAt != null &&
          now - first.lastDailyDigestAt <
            DAILY_WINDOW_MS - HOURLY_WINDOW_MS * 2;
        if (sentToday) continue;
        if (!overdue && !atDigestHour(now, hour, offset)) continue;
        dailyUserIds.push(first.userId);
      }
      emails.push(digestEmail(publicUrl, bucket, name));
    }
  }
  return { emails, skippedIds, dailyUserIds };
};

const fetchUnmailedNotifications = async (
  db: AppDb,
): Promise<SweepNotificationRow[]> =>
  await db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      kind: notifications.kind,
      payloadJson: notifications.payloadJson,
      createdAt: notifications.createdAt,
      email: users.email,
      workspaceName: workspaces.name,
      lastDailyDigestAt: notificationPreferences.lastDailyDigestAt,
      mode: sql<NotificationMode>`coalesce(${notificationPreferences.mode}, 'instant')`,
      kindModesJson: sql<string>`coalesce(${notificationPreferences.kindModesJson}, '{}')`,
      digestHour: sql<number>`coalesce(${notificationPreferences.digestHour}, 8)`,
      utcOffsetMinutes: sql<number>`coalesce(${notificationPreferences.utcOffsetMinutes}, 0)`,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .innerJoin(workspaces, eq(workspaces.id, users.workspaceId))
    .leftJoin(
      notificationPreferences,
      eq(notificationPreferences.userId, notifications.userId),
    )
    .where(isNull(notifications.emailedAt))
    .orderBy(asc(notifications.createdAt), asc(notifications.id))
    .limit(EMAIL_SWEEP_LIMIT)
    .all();

const markEmailed = async (
  db: AppDb,
  ids: string[],
  at: number,
): Promise<void> => {
  for (const group of chunkArray(ids, 100)) {
    await db
      .update(notifications)
      .set({ emailedAt: at })
      .where(inArray(notifications.id, group))
      .run();
  }
};

const sweepNotificationEmails = async (
  db: AppDb,
  config: MaintenanceConfig,
  mailer: Mailer | null,
  now: number,
): Promise<void> => {
  const rows = await fetchUnmailedNotifications(db);
  if (!rows.length) return;
  if (!mailer) {
    await markEmailed(
      db,
      rows.map((row) => row.id),
      EMAIL_SENTINEL_AT,
    );
    log(
      `email sweep: marked ${rows.length} notifications without sending because email is disabled.`,
    );
    return;
  }
  /* One token per recipient, signed the same way the API verifies it. Without
     a secret there is simply no unsubscribe header, rather than a broken one. */
  const tokens = new Map<string, string>();
  if (config.secretKey)
    for (const userId of new Set(rows.map((row) => row.userId)))
      tokens.set(userId, await unsubscribeToken(config.secretKey, userId));
  const plan = planEmailSweep(
    rows.map((row) => {
      const token = tokens.get(row.userId);
      return token ? { ...row, unsubscribeToken: token } : row;
    }),
    now,
    config.publicUrl,
  );
  if (plan.skippedIds.length) {
    await markEmailed(db, plan.skippedIds, EMAIL_SENTINEL_AT);
    warn(
      `email sweep: marked ${plan.skippedIds.length} notifications for recipients without an email address.`,
    );
  }
  /* Stamp the daily summaries before sending them: sending twice is worse than
     missing one, and a crash between the two should not mean a second copy. */
  for (const userId of plan.dailyUserIds)
    await db
      .insert(notificationPreferences)
      .values({ userId, lastDailyDigestAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: { lastDailyDigestAt: now },
      })
      .run();
  for (const email of plan.emails) {
    try {
      await mailer.send({
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: email.headers,
      });
      await markEmailed(db, email.notificationIds, now);
    } catch (error) {
      // Rows stay unmailed and are retried on the next sweep.
      warn(
        `email to ${email.to} failed and will be retried: ${errorText(error)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Upload session reaping.
// ---------------------------------------------------------------------------

const deleteBlobQuietly = async (
  store: BlobStore,
  key: string,
): Promise<void> => {
  try {
    await store.delete(key);
  } catch (error) {
    warn(`blob ${key} was not deleted: ${errorText(error)}`);
  }
};

export const reapUploadSessions = async (
  db: AppDb,
  store: BlobStore,
  now: number,
  olderThanMs: number,
): Promise<void> => {
  const cutoff = now - olderThanMs;
  const stale = await db
    .select()
    .from(uploadSessions)
    .where(
      or(
        and(
          inArray(uploadSessions.status, [
            "pending",
            "uploading",
            "quarantined",
            "aborted",
          ]),
          lt(uploadSessions.createdAt, cutoff),
        ),
        and(
          eq(uploadSessions.status, "completed"),
          lt(uploadSessions.completedAt, cutoff),
        ),
      ),
    )
    .orderBy(asc(uploadSessions.createdAt))
    .limit(UPLOAD_REAP_LIMIT)
    .all();
  let reaped = 0;
  for (const session of stale) {
    // A pending session should never back a registered version, but the
    // blob at session.blob_key would be the version's original if one did;
    // guard before touching anything.
    const versionRef = await db
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(eq(assetVersions.uploadSessionId, session.id))
      .limit(1)
      .all();
    if (versionRef.length) {
      warn(
        `upload reap: session ${session.id} is referenced by a version and was skipped.`,
      );
      continue;
    }
    const abortMultipart = (
      store as Partial<MultipartBlobStore>
    ).abortMultipart?.bind(store);
    if (session.uploadId && abortMultipart) {
      try {
        await abortMultipart(session.uploadId);
      } catch (error) {
        warn(
          `upload reap: multipart abort for session ${session.id} failed: ${errorText(error)}`,
        );
      }
    }
    // Remove any partially assembled object at the final key (idempotent
    // when nothing was assembled).
    await deleteBlobQuietly(store, session.blobKey);
    await db
      .delete(uploadParts)
      .where(eq(uploadParts.uploadId, session.id))
      .run();
    await db
      .delete(uploadSessions)
      .where(eq(uploadSessions.id, session.id))
      .run();
    reaped += 1;
  }
  if (reaped) log(`upload reap: removed ${reaped} stale upload sessions.`);
};

// ---------------------------------------------------------------------------
// Trash purge.
// ---------------------------------------------------------------------------

type RenditionKeySource = Pick<
  typeof renditions.$inferSelect,
  "blobKey" | "metaJson"
>;

/** All object keys a rendition row owns: main blob, VTT sidecar, PDF pages. */
const renditionBlobKeys = (row: RenditionKeySource): string[] => {
  const keys = [row.blobKey];
  const meta = parseObjectJson(row.metaJson);
  if (typeof meta.vtt_blob_key === "string") keys.push(meta.vtt_blob_key);
  if (Array.isArray(meta.pages)) {
    // pdf_pages registers the first page as blob_key and lists every page
    // basename in meta.pages.
    const directory = path.posix.dirname(row.blobKey.replaceAll("\\", "/"));
    for (const page of meta.pages)
      if (typeof page === "string") keys.push(`${directory}/${page}`);
  }
  return keys;
};

const versionBlobKeys = async (
  db: AppDb,
  version: typeof assetVersions.$inferSelect,
): Promise<string[]> => {
  const keys = [version.originalBlobKey];
  const renditionRows = await db
    .select({ blobKey: renditions.blobKey, metaJson: renditions.metaJson })
    .from(renditions)
    .where(eq(renditions.versionId, version.id))
    .all();
  for (const row of renditionRows) keys.push(...renditionBlobKeys(row));
  const attachmentRows = await db
    .select({ blobKey: commentAttachments.blobKey })
    .from(commentAttachments)
    .innerJoin(comments, eq(commentAttachments.commentId, comments.id))
    .where(eq(comments.versionId, version.id))
    .all();
  for (const row of attachmentRows) keys.push(row.blobKey);
  /* Caption sidecars are the version's too, and are the one blob a purge used
     to miss: their rows cascade with the version but the object was left for
     the GC, stranded whenever GC-delete is off. */
  const captionRows = await db
    .select({ blobKey: captionTracks.blobKey })
    .from(captionTracks)
    .where(eq(captionTracks.versionId, version.id))
    .all();
  for (const row of captionRows) keys.push(row.blobKey);
  return keys;
};

/**
 * carried_from_comment_id has no ON DELETE action, so a carried comment on
 * a newer version blocks deletion of its referent. Null every link into the
 * doomed comment set before the cascading delete.
 */
const clearCarriedLinksForVersions = async (
  db: AppDb,
  versionIds: string[],
): Promise<void> => {
  if (!versionIds.length) return;
  await db
    .update(comments)
    .set({ carriedFromCommentId: null })
    .where(
      inArray(
        comments.carriedFromCommentId,
        db
          .select({ id: comments.id })
          .from(comments)
          .where(inArray(comments.versionId, versionIds)),
      ),
    )
    .run();
};

const deleteUploadSessionsById = async (
  db: AppDb,
  sessionIds: string[],
): Promise<void> => {
  if (!sessionIds.length) return;
  // Sessions are parents of asset_versions with no cascade, so they are
  // deleted only after the referencing versions are gone. upload_parts
  // cascades off the session row.
  await db
    .delete(uploadSessions)
    .where(inArray(uploadSessions.id, sessionIds))
    .run();
};

export const purgeTrashedAssets = async (
  db: AppDb,
  store: BlobStore,
  now: number,
  olderThanMs: number,
): Promise<void> => {
  const cutoff = now - olderThanMs;
  const rows = await db
    .select({ asset: assets, workspaceId: projects.workspaceId })
    .from(assets)
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(and(isNotNull(assets.deletedAt), lt(assets.deletedAt, cutoff)))
    .orderBy(asc(assets.deletedAt))
    .limit(TRASH_PURGE_LIMIT)
    .all();
  for (const row of rows) {
    const versions = await db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.assetId, row.asset.id))
      .all();
    /* Collect every blob key BEFORE the delete: the rendition rows that name
       them cascade away with the asset, so they must be read first -- but they
       are freed only AFTER the row is confirmed gone (below), never before, so
       a restore that spares the row never loses its media. */
    const blobKeys = new Set<string>();
    for (const version of versions)
      for (const key of await versionBlobKeys(db, version)) blobKeys.add(key);
    if (row.asset.thumbnailBlobKey) blobKeys.add(row.asset.thumbnailBlobKey);
    // Nulling inbound carry links must precede the cascade (comments carry a
    // no-cascade self reference). A restore after this loses only the "carried
    // from" linkage, not the asset -- an acceptable cost for the rare race.
    await clearCarriedLinksForVersions(
      db,
      versions.map((version) => version.id),
    );
    /* The delete re-asserts deletedAt < cutoff, so a restore between the scan
       above and here (which sets deletedAt = null) leaves the row untouched:
       the purge declines to destroy a resurrected asset. One delete cascades
       versions, renditions, comments, attachments, reads, reactions, and
       share_assets. */
    await db
      .delete(assets)
      .where(
        and(
          eq(assets.id, row.asset.id),
          isNotNull(assets.deletedAt),
          lt(assets.deletedAt, cutoff),
        ),
      )
      .run();
    const survived = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.id, row.asset.id))
      .limit(1)
      .all();
    if (survived.length) {
      log(
        `trash purge: asset ${row.asset.id} was restored mid-sweep; spared (media intact).`,
      );
      continue;
    }
    // The row is gone: now it is safe to free the media and the sessions.
    for (const key of blobKeys) await deleteBlobQuietly(store, key);
    /* Give the freed bytes back to the project's counter. It is only ever
       incremented on upload, so without this it drifts upward forever and a
       project's reported storage climbs past what is actually on disk. MAX(0,..)
       guards against a pre-existing over-count going negative. */
    const freedBytes = versions.reduce(
      (total, version) => total + (version.size ?? 0),
      0,
    );
    if (freedBytes > 0)
      await db
        .update(projects)
        .set({
          storageBytes: sql`MAX(0, ${projects.storageBytes} - ${freedBytes})`,
        })
        .where(eq(projects.id, row.asset.projectId))
        .run();
    await deleteUploadSessionsById(
      db,
      versions.map((version) => version.uploadSessionId),
    );
    await db
      .insert(auditLog)
      .values({
        id: new UlidGenerator().ulid(),
        workspaceId: row.workspaceId,
        actorUserId: null,
        action: "asset.purge",
        target: row.asset.id,
        metaJson: JSON.stringify({
          project_id: row.asset.projectId,
          name: row.asset.name,
          versions: versions.length,
        }),
        at: now,
      })
      .run();
    log(
      `trash purge: asset ${row.asset.id} purged (${versions.length} versions).`,
    );
  }
};

export const purgeTrashedVersions = async (
  db: AppDb,
  store: BlobStore,
  now: number,
  olderThanMs: number,
): Promise<void> => {
  const cutoff = now - olderThanMs;
  const rows = await db
    .select({
      version: assetVersions,
      assetId: assets.id,
      workspaceId: projects.workspaceId,
    })
    .from(assetVersions)
    .innerJoin(assets, eq(assetVersions.assetId, assets.id))
    .innerJoin(projects, eq(assets.projectId, projects.id))
    .where(
      and(
        isNotNull(assetVersions.deletedAt),
        lt(assetVersions.deletedAt, cutoff),
      ),
    )
    .orderBy(asc(assetVersions.deletedAt))
    .limit(TRASH_PURGE_LIMIT)
    .all();
  for (const row of rows) {
    for (const key of await versionBlobKeys(db, row.version))
      await deleteBlobQuietly(store, key);
    await clearCarriedLinksForVersions(db, [row.version.id]);
    await db
      .delete(assetVersions)
      .where(eq(assetVersions.id, row.version.id))
      .run();
    await deleteUploadSessionsById(db, [row.version.uploadSessionId]);
    await db
      .insert(auditLog)
      .values({
        id: new UlidGenerator().ulid(),
        workspaceId: row.workspaceId,
        actorUserId: null,
        action: "version.purge",
        target: row.version.id,
        metaJson: JSON.stringify({
          asset_id: row.assetId,
          version_no: row.version.versionNo,
        }),
        at: now,
      })
      .run();
    log(`trash purge: version ${row.version.id} purged.`);
  }
};

// ---------------------------------------------------------------------------
// Blob GC reconciliation (dry run unless ONELIGHT_GC_DELETE=true).
// ---------------------------------------------------------------------------

export interface BlobObject {
  key: string;
  size: number;
  mtimeMs: number;
}

/**
 * Walk a local blob root and return every object with its forward-slash key
 * relative to the root. Dot-directories (.multipart staging, still temp
 * dirs) and .tmp-* in-flight writes are not objects and are skipped.
 */
export const walkBlobObjects = async (root: string): Promise<BlobObject[]> => {
  const objects: BlobObject[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, key);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.tmp-/i.test(entry.name)) continue;
      try {
        const info = await stat(full);
        objects.push({ key, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Deleted between readdir and stat; not an object anymore.
      }
    }
  };
  await walk(root, "");
  return objects;
};

export const diffOrphanBlobs = (
  objects: BlobObject[],
  referenced: ReadonlySet<string>,
): BlobObject[] => objects.filter((object) => !referenced.has(object.key));

export const referencedBlobKeys = async (db: AppDb): Promise<Set<string>> => {
  const keys = new Set<string>();
  for (const row of await db
    .select({ key: uploadSessions.blobKey })
    .from(uploadSessions)
    .where(
      inArray(uploadSessions.status, ["pending", "uploading", "completed"]),
    )
    .all())
    keys.add(row.key);
  for (const row of await db
    .select({ key: assetVersions.originalBlobKey })
    .from(assetVersions)
    .all())
    keys.add(row.key);
  for (const row of await db
    .select({ blobKey: renditions.blobKey, metaJson: renditions.metaJson })
    .from(renditions)
    .all())
    for (const key of renditionBlobKeys(row)) keys.add(key);
  for (const row of await db
    .select({ key: exportJobs.resultBlobKey })
    .from(exportJobs)
    .where(isNotNull(exportJobs.resultBlobKey))
    .all())
    if (row.key) keys.add(row.key);
  for (const row of await db
    .select({ key: commentAttachments.blobKey })
    .from(commentAttachments)
    .all())
    keys.add(row.key);
  /* Uploaded project covers. Their upload session also names the blob, so this
     is belt and braces today -- but a cover must not depend on a session row
     surviving forever to keep its picture from being swept. */
  for (const row of await db
    .select({ key: projects.coverBlobKey })
    .from(projects)
    .where(isNotNull(projects.coverBlobKey))
    .all())
    if (row.key) keys.add(row.key);
  /* Covers uploaded but not currently in force: still offered in settings, so
     still referenced. Sweeping these would empty the picker. */
  for (const row of await db
    .select({ key: projectCoverUploads.blobKey })
    .from(projectCoverUploads)
    .all())
    keys.add(row.key);
  for (const row of await db
    .select({ key: captionTracks.blobKey })
    .from(captionTracks)
    .all())
    keys.add(row.key);
  /* Chosen asset thumbnails (migration 0019). The blob is an upload session's
     object, and sessions are reaped, so the asset row is the only thing
     keeping it alive. */
  for (const row of await db
    .select({ key: assets.thumbnailBlobKey })
    .from(assets)
    .where(isNotNull(assets.thumbnailBlobKey))
    .all())
    if (row.key) keys.add(row.key);
  /* Avatars live under the same blob root as everything else, so omitting them
     here does not merely fail to clean up: the GC walks them, finds no
     reference, and deletes the picture a day after it was uploaded. That is
     exactly what happened in production before this loop existed. */
  for (const row of await db
    .select({ key: users.avatarKey })
    .from(users)
    .where(isNotNull(users.avatarKey))
    .all())
    if (row.key) keys.add(row.key);
  /* Share logos. The blob's ONLY reference is shares.brand_json.logo_key -- no
     column, no session -- so leaving it out is not a missed cleanup but the
     avatar incident again: the GC walks the sharelogos/ objects, finds no
     reference, and deletes a live logo a day after upload. */
  for (const row of await db
    .select({ brandJson: shares.brandJson })
    .from(shares)
    .where(isNotNull(shares.brandJson))
    .all()) {
    if (!row.brandJson) continue;
    try {
      const brand = JSON.parse(row.brandJson) as { logo_key?: unknown };
      if (typeof brand.logo_key === "string") keys.add(brand.logo_key);
    } catch {
      /* A malformed brand blob names no logo; nothing to protect. */
    }
  }
  return keys;
};

/* The manifest a backup writes beside each DB snapshot: every blob key that
   snapshot references. Read here so the GC can protect them. */
export interface BackupManifest {
  created_at: string;
  blob_keys: string[];
}

export const readBackupManifests = (dir: string): BackupManifest[] => {
  let names: string[];
  try {
    names = fsSync.readdirSync(dir);
  } catch {
    return [];
  }
  const manifests: BackupManifest[] = [];
  for (const name of names) {
    if (!name.endsWith(".manifest.json")) continue;
    try {
      const parsed = JSON.parse(
        fsSync.readFileSync(path.join(dir, name), "utf8"),
      ) as BackupManifest;
      if (Array.isArray(parsed.blob_keys)) manifests.push(parsed);
    } catch {
      /* A truncated or malformed manifest protects nothing; skip it. */
    }
  }
  return manifests;
};

/* The union of every retained backup's referenced blob keys. The GC adds this
   to its live referenced-set so a blob any snapshot still needs is never swept.
   Explicit deletes (trash purge, project/user delete) are a separate matter: a
   snapshot taken before a delete legitimately loses those blobs, and the
   manifest is how a restore detects it. */
export const backupReferencedBlobKeys = (dir: string): Set<string> => {
  const keys = new Set<string>();
  for (const manifest of readBackupManifests(dir))
    for (const key of manifest.blob_keys) keys.add(key);
  return keys;
};

const runBlobGc = async (
  db: AppDb,
  config: MaintenanceConfig,
  now: number,
): Promise<void> => {
  const store = config.blobStore;
  if (!(store instanceof LocalBlobStore)) {
    log("blob gc: skipped, only a LocalBlobStore root can be walked.");
    return;
  }
  const objects = await walkBlobObjects(store.root);
  const referenced = await referencedBlobKeys(db);
  /* A blob any retained snapshot still references is protected too, so the
     sweep cannot delete a blob out from under a backup you might restore. */
  if (config.backupDir)
    for (const key of backupReferencedBlobKeys(config.backupDir))
      referenced.add(key);
  const orphans = diffOrphanBlobs(objects, referenced);
  const totalBytes = orphans.reduce((sum, object) => sum + object.size, 0);
  log(
    `blob gc: ${orphans.length} orphaned objects totaling ${totalBytes} bytes (${objects.length} objects walked, ${referenced.size} referenced keys).`,
  );
  for (const orphan of orphans.slice(0, GC_LOG_LIMIT))
    log(`blob gc orphan: ${orphan.key} (${orphan.size} bytes)`);
  if (orphans.length > GC_LOG_LIMIT)
    log(`blob gc: ${orphans.length - GC_LOG_LIMIT} more orphans not listed.`);
  if (!config.gcDelete) {
    if (orphans.length)
      log(
        "blob gc: dry run only. Set ONELIGHT_GC_DELETE=true to delete orphans older than 24 hours.",
      );
    return;
  }
  let deleted = 0;
  for (const orphan of orphans) {
    if (now - orphan.mtimeMs < GC_ORPHAN_MIN_AGE_MS) continue;
    await deleteBlobQuietly(store, orphan.key);
    deleted += 1;
  }
  log(`blob gc: deleted ${deleted} orphaned objects.`);
};

// ---------------------------------------------------------------------------
// Loop.
// ---------------------------------------------------------------------------

/**
 * Start the maintenance loop: every 60 seconds it emails unmailed
 * notifications, reaps stale upload sessions, and purges expired trash;
 * blob GC reconciliation runs at most once per gcIntervalMs. Returns a stop
 * function.
 */
export const startMaintenance = (
  db: AppDb,
  config: MaintenanceConfig,
  /* Resolved each tick, so mail settings changed in the admin UI apply to
     the next sweep without a restart. */
  getMailer: () => Promise<Mailer | null>,
): (() => void) => {
  let active = false;
  let lastGcAt = 0;
  const tick = async (): Promise<void> => {
    if (active) return;
    active = true;
    try {
      const now = Date.now();
      try {
        await sweepNotificationEmails(db, config, await getMailer(), now);
      } catch (error) {
        warn(`email sweep failed: ${errorText(error)}`);
      }
      try {
        await reapUploadSessions(
          db,
          config.blobStore,
          now,
          config.uploadReapAfterMs,
        );
      } catch (error) {
        warn(`upload reap failed: ${errorText(error)}`);
      }
      try {
        await purgeTrashedAssets(
          db,
          config.blobStore,
          now,
          config.trashPurgeAfterMs,
        );
        await purgeTrashedVersions(
          db,
          config.blobStore,
          now,
          config.trashPurgeAfterMs,
        );
      } catch (error) {
        warn(`trash purge failed: ${errorText(error)}`);
      }
      if (now - lastGcAt >= config.gcIntervalMs) {
        lastGcAt = now;
        try {
          await runBlobGc(db, config, now);
        } catch (error) {
          warn(`blob gc failed: ${errorText(error)}`);
        }
      }
    } finally {
      active = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, SWEEP_INTERVAL_MS);
  void tick();
  return () => clearInterval(timer);
};
