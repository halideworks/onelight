import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { UlidGenerator } from "@onelight/core";
import type { BlobStore, MultipartBlobStore } from "@onelight/core";
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
  projectCoverUploads,
  projects,
  renditions,
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
  blobStore: BlobStore;
  uploadReapAfterMs: number;
  trashPurgeAfterMs: number;
  gcIntervalMs: number;
  gcDelete: boolean;
}

const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const maintenanceConfigFromEnv = (
  env: Record<string, string | undefined>,
  base: { publicUrl: string; blobStore: BlobStore },
): MaintenanceConfig => {
  const gcDelete = (env.ONELIGHT_GC_DELETE ?? "").trim().toLowerCase();
  return {
    publicUrl: base.publicUrl,
    blobStore: base.blobStore,
    uploadReapAfterMs: positiveInt(
      env.UPLOAD_REAP_AFTER_MS,
      DEFAULT_UPLOAD_REAP_AFTER_MS,
    ),
    trashPurgeAfterMs: positiveInt(
      env.TRASH_PURGE_AFTER_MS,
      DEFAULT_TRASH_PURGE_AFTER_MS,
    ),
    gcIntervalMs: positiveInt(env.GC_INTERVAL_MS, DEFAULT_GC_INTERVAL_MS),
    gcDelete: gcDelete === "true" || gcDelete === "1",
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

export type NotificationMode = "instant" | "hourly" | "daily";

export interface SweepNotificationRow {
  id: string;
  userId: string;
  kind: string;
  payloadJson: string;
  createdAt: number;
  email: string;
  mode: NotificationMode;
}

export interface PlannedEmail {
  to: string;
  subject: string;
  text: string;
  notificationIds: string[];
}

export interface EmailSweepPlan {
  emails: PlannedEmail[];
  /** Rows to sentinel-mark because the user has no email address. */
  skippedIds: string[];
}

export const subjectForKind = (kind: string): string => {
  switch (kind) {
    case "comment.created":
      return "Onelight: new comment";
    case "comment.reply":
      return "Onelight: new reply";
    case "comment.mention":
      return "Onelight: you were mentioned";
    case "approval.updated":
      return "Onelight: approval status changed";
    case "transcode.failed":
      return "Onelight: transcode failed";
    case "version.created":
      return "Onelight: new version uploaded";
    default:
      return "Onelight: notification";
  }
};

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

const notificationLine = (
  publicUrl: string,
  row: SweepNotificationRow,
): { summary: string; link: string | null } => {
  const payload = parseObjectJson(row.payloadJson);
  const preview = typeof payload.preview === "string" ? payload.preview : "";
  const assetName =
    typeof payload.asset_name === "string" ? payload.asset_name : "";
  const summary = preview || assetName || subjectForKind(row.kind);
  return { summary, link: notificationDeepLink(publicUrl, payload) };
};

const instantEmail = (
  publicUrl: string,
  row: SweepNotificationRow,
): PlannedEmail => {
  const { summary, link } = notificationLine(publicUrl, row);
  const lines = [summary];
  if (link) lines.push("", `Open in Onelight: ${link}`);
  return {
    to: row.email,
    subject: subjectForKind(row.kind),
    text: lines.join("\n") + "\n",
    notificationIds: [row.id],
  };
};

const digestEmail = (
  publicUrl: string,
  rows: SweepNotificationRow[],
): PlannedEmail => {
  const first = rows[0] as SweepNotificationRow;
  const lines = [
    `You have ${rows.length} unread notification${rows.length === 1 ? "" : "s"} in Onelight.`,
    "",
  ];
  for (const row of rows) {
    const { summary, link } = notificationLine(publicUrl, row);
    lines.push(
      `- ${subjectForKind(row.kind).replace(/^Onelight: /, "")}: ${summary}`,
    );
    if (link) lines.push(`  ${link}`);
  }
  return {
    to: first.email,
    subject: `Onelight: ${rows.length} new notification${rows.length === 1 ? "" : "s"}`,
    text: lines.join("\n") + "\n",
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
): EmailSweepPlan => {
  const emails: PlannedEmail[] = [];
  const skippedIds: string[] = [];
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
    const mode = (userRows[0] as SweepNotificationRow).mode;
    if (mode === "instant") {
      for (const row of userRows) emails.push(instantEmail(publicUrl, row));
      continue;
    }
    const windowMs = mode === "hourly" ? HOURLY_WINDOW_MS : DAILY_WINDOW_MS;
    const oldest = Math.min(...userRows.map((row) => row.createdAt));
    if (now - oldest < windowMs) continue;
    emails.push(digestEmail(publicUrl, userRows));
  }
  return { emails, skippedIds };
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
      mode: sql<NotificationMode>`coalesce(${notificationPreferences.mode}, 'instant')`,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
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
  const plan = planEmailSweep(rows, now, config.publicUrl);
  if (plan.skippedIds.length) {
    await markEmailed(db, plan.skippedIds, EMAIL_SENTINEL_AT);
    warn(
      `email sweep: marked ${plan.skippedIds.length} notifications for recipients without an email address.`,
    );
  }
  for (const email of plan.emails) {
    try {
      await mailer.send({
        to: email.to,
        subject: email.subject,
        text: email.text,
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

const reapUploadSessions = async (
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
      and(
        inArray(uploadSessions.status, ["pending", "uploading"]),
        lt(uploadSessions.createdAt, cutoff),
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

const purgeTrashedAssets = async (
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
    // Blobs first: a crash between blob and row deletion leaves rows the
    // next sweep retries against idempotent deletes.
    for (const version of versions)
      for (const key of await versionBlobKeys(db, version))
        await deleteBlobQuietly(store, key);
    await clearCarriedLinksForVersions(
      db,
      versions.map((version) => version.id),
    );
    // The asset row goes last so one delete cascades versions, renditions,
    // comments, attachments, reads, reactions, and share_assets.
    await db.delete(assets).where(eq(assets.id, row.asset.id)).run();
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

const purgeTrashedVersions = async (
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
