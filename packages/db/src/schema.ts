import { relations, sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// Uniqueness convention: uniqueIndex(...) mirrors a CREATE UNIQUE INDEX
// statement in the migrations; column .unique() and table unique().on(...)
// mirror inline UNIQUE constraints in the CREATE TABLE DDL.

// drizzle's sqlite text column has no collation option, so the NOCASE
// columns from the migrations are expressed as a custom type.
const nocaseText = customType<{ data: string }>({
  dataType() {
    return "text COLLATE NOCASE";
  },
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  settingsJson: text("settings_json").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: nocaseText("email").notNull(),
    name: text("name").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    /* Guests are stored as members with this flag (the users table's role
       CHECK predates the tier and a rebuild would cascade through every
       session and token); the API derives the effective "guest" role at
       the auth boundary, so nothing above the row layer sees the flag. */
    guest: integer("guest", { mode: "boolean" }).notNull().default(false),
    passwordHash: text("password_hash"),
    avatarKey: text("avatar_key"),
    /* TOTP: the secret sits unverified until a code proves the enrolment,
       and backup codes are stored only as SHA-256 hashes. */
    totpSecret: text("totp_secret"),
    totpVerifiedAt: integer("totp_verified_at"),
    totpBackupCodesJson: text("totp_backup_codes_json").notNull().default("[]"),
    disabledAt: integer("disabled_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("users_email_uq").on(
      table.workspaceId,
      table.email,
    ),
  }),
);

export const identities = sqliteTable(
  "identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("oidc"),
    subject: text("subject").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    subjectUnique: uniqueIndex("identities_subject_uq").on(
      table.provider,
      table.subject,
    ),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => ({
    tokenUnique: uniqueIndex("sessions_token_uq").on(table.tokenHash),
    userIndex: index("sessions_user_idx").on(table.userId),
  }),
);

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: nocaseText("email").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    guest: integer("guest", { mode: "boolean" }).notNull().default(false),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    projectGrantsJson: text("project_grants_json").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
  },
  (table) => ({
    tokenUnique: uniqueIndex("invites_token_uq").on(table.tokenHash),
  }),
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => ({
    tokenUnique: uniqueIndex("api_tokens_hash_uq").on(table.tokenHash),
  }),
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "archived"] })
      .notNull()
      .default("active"),
    palette: text("palette").notNull(),
    /** An asset in this project whose poster stands in as the cover picture.
        A soft reference, like assets.current_version_id: a cover pointing at a
        deleted asset reads as no cover, not as a broken row. */
    coverAssetId: text("cover_asset_id"),
    /** An uploaded cover picture, shown as-is. Mutually exclusive with
        coverAssetId in practice: setting either clears the other. */
    coverBlobKey: text("cover_blob_key"),
    restricted: integer("restricted", { mode: "boolean" })
      .notNull()
      .default(false),
    storageBytes: integer("storage_bytes").notNull().default(0),
    settingsJson: text("settings_json").notNull().default("{}"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    workspaceIndex: index("projects_ws_idx").on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", {
      enum: ["manager", "editor", "commenter", "viewer"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.projectId, table.userId] }),
  }),
);

/** Pictures uploaded as this project's cover, kept as options after another
    cover is chosen. The cover in force is projects.cover_blob_key. */
export const projectCoverUploads = sqliteTable(
  "project_cover_uploads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    blobKey: text("blob_key").notNull(),
    filename: text("filename").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    projectIndex: index("project_cover_uploads_project_idx").on(
      table.projectId,
      table.id,
    ),
    blobUnique: uniqueIndex("project_cover_uploads_blob_uq").on(
      table.projectId,
      table.blobKey,
    ),
  }),
);

export const folders = sqliteTable(
  "folders",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => folders.id, {
      onDelete: "cascade",
    }),
    /** Which tree this folder belongs to. 'assets' folders hold assets;
        'shares' folders hold shares. The two never mix: an asset is in exactly
        one folder, a share is in any number of assets' worth of them. */
    kind: text("kind", { enum: ["assets", "shares"] })
      .notNull()
      .default("assets"),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    siblingUnique: uniqueIndex("folders_sibling_uq").on(
      table.projectId,
      table.kind,
      sql`ifnull(${table.parentId}, '')`,
      table.name,
    ),
    parentIndex: index("folders_parent_idx").on(table.parentId),
  }),
);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  count: integer("count").notNull(),
});

export const uploadSessions = sqliteTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    clientFilename: text("client_filename").notNull(),
    relativePath: text("relative_path").notNull(),
    size: integer("size").notNull(),
    checksumCrc32c: text("checksum_crc32c"),
    blobKey: text("blob_key").notNull(),
    uploadId: text("upload_id"),
    partSize: integer("part_size"),
    status: text("status", {
      enum: ["pending", "uploading", "completed", "quarantined", "aborted"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => ({
    projectIndex: index("upload_sessions_project_idx").on(
      table.projectId,
      table.status,
    ),
  }),
);

export const uploadParts = sqliteTable(
  "upload_parts",
  {
    uploadId: text("upload_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    partNo: integer("part_no").notNull(),
    etag: text("etag"),
    size: integer("size"),
    completedAt: integer("completed_at"),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.uploadId, table.partNo] }),
  }),
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["video", "audio", "image", "pdf", "file"],
    }).notNull(),
    currentVersionId: text("current_version_id"),
    status: text("status", {
      enum: ["none", "in_review", "approved", "changes_requested"],
    })
      .notNull()
      .default("none"),
    description: text("description").notNull().default(""),
    tagsJson: text("tags_json").notNull().default("[]"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    projectIndex: index("assets_project_idx").on(
      table.projectId,
      table.deletedAt,
      table.id,
    ),
  }),
);

export const assetVersions = sqliteTable(
  "asset_versions",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    uploadSessionId: text("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id)
      .unique(),
    versionNo: integer("version_no").notNull(),
    originalBlobKey: text("original_blob_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    size: integer("size").notNull(),
    checksumCrc32c: text("checksum_crc32c").notNull(),
    uploadedBy: text("uploaded_by")
      .notNull()
      .references(() => users.id),
    mediaInfoJson: text("media_info_json").notNull().default("{}"),
    sourceTimecodeStart: text("source_timecode_start"),
    sourceStartFrame: integer("source_start_frame"),
    frameRateNum: integer("frame_rate_num"),
    frameRateDen: integer("frame_rate_den"),
    dropFrame: integer("drop_frame", { mode: "boolean" }),
    durationFrames: integer("duration_frames"),
    colorJson: text("color_json").notNull().default("{}"),
    transcodeStatus: text("transcode_status", {
      enum: ["pending", "processing", "ready", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    /** Set once a transcode.failed notification has been materialized. */
    failureNotifiedAt: integer("failure_notified_at"),
  },
  (table) => ({
    assetVersionUnique: unique().on(table.assetId, table.versionNo),
    assetIndex: index("asset_versions_asset_idx").on(
      table.assetId,
      table.versionNo,
    ),
    // Serves the GET /notifications materialize-once scan for versions that
    // have failed but have not yet had a notification written.
    failedIndex: index("asset_versions_failed_idx")
      .on(table.id)
      .where(
        sql`${table.transcodeStatus} = 'failed' AND ${table.failureNotifiedAt} IS NULL`,
      ),
  }),
);

export const renditions = sqliteTable(
  "renditions",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "proxy_2160",
        "proxy_1080",
        "proxy_540",
        "hdr_hevc",
        "hdr_av1",
        "audio_peaks",
        "sprite",
        "poster",
        "pdf_pages",
        "still_tiles",
        "watermarked",
      ],
    }).notNull(),
    blobKey: text("blob_key").notNull(),
    metaJson: text("meta_json").notNull().default("{}"),
    size: integer("size").notNull().default(0),
    checksumSha256: text("checksum_sha256").notNull().default(""),
    shareId: text("share_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    baseUnique: uniqueIndex("renditions_base_uq")
      .on(table.versionId, table.kind)
      .where(sql`${table.shareId} IS NULL`),
    shareUnique: uniqueIndex("renditions_share_uq")
      .on(table.versionId, table.kind, table.shareId)
      .where(sql`${table.shareId} IS NOT NULL`),
  }),
);

/* Caption sidecars: a WebVTT per language, uploaded by people or a
   deployment's captioning hook. Not a rendition because the pipeline never
   makes these. */
export const captionTracks = sqliteTable(
  "caption_tracks",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    language: text("language").notNull(),
    label: text("label").notNull(),
    blobKey: text("blob_key").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    versionLanguageUnique: uniqueIndex("caption_tracks_version_lang_uq").on(
      table.versionId,
      table.language,
    ),
  }),
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status", {
      enum: ["queued", "processing", "complete", "failed", "dead"],
    }).notNull(),
    priority: integer("priority").notNull().default(0),
    capabilityJson: text("capability_json").notNull().default("{}"),
    maxAttempts: integer("max_attempts").notNull().default(5),
    attempts: integer("attempts").notNull().default(0),
    runAfter: integer("run_after").notNull(),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    heartbeatAt: integer("heartbeat_at"),
    leaseExpiresAt: integer("lease_expires_at"),
    finishedAt: integer("finished_at"),
    error: text("error"),
    workerId: text("worker_id"),
  },
  (table) => ({
    claimIndex: index("jobs_claim_idx").on(table.status, table.runAfter),
  }),
);

export const projectEvents = sqliteTable(
  "project_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    replayIndex: index("project_events_replay_idx").on(
      table.projectId,
      table.id,
    ),
  }),
);

/* Instance-level settings editable from the admin UI (migration 0014).
   One row per key; the value is JSON. First occupant: "mail". */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by"),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    target: text("target"),
    metaJson: text("meta_json").notNull().default("{}"),
    at: integer("at").notNull(),
  },
  (table) => ({
    workspaceAtIndex: index("audit_ws_at_idx").on(table.workspaceId, table.at),
  }),
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => comments.id, {
      onDelete: "cascade",
    }),
    authorUserId: text("author_user_id").references(() => users.id),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    viewerKey: text("viewer_key"),
    frameIn: integer("frame_in"),
    frameOut: integer("frame_out"),
    bodyText: text("body_text").notNull(),
    annotationJson: text("annotation_json"),
    pinXyJson: text("pin_xy_json"),
    pageNo: integer("page_no"),
    internal: integer("internal", { mode: "boolean" }).notNull().default(false),
    completedAt: integer("completed_at"),
    completedBy: text("completed_by").references(() => users.id),
    carriedFromCommentId: text("carried_from_comment_id").references(
      (): AnySQLiteColumn => comments.id,
    ),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    editedAt: integer("edited_at"),
  },
  (table) => ({
    versionFrameIndex: index("comments_version_frame_idx").on(
      table.versionId,
      table.deletedAt,
      table.frameIn,
      table.id,
    ),
  }),
);

export const commentAttachments = sqliteTable("comment_attachments", {
  id: text("id").primaryKey(),
  commentId: text("comment_id")
    .notNull()
    .references(() => comments.id, { onDelete: "cascade" }),
  blobKey: text("blob_key").notNull(),
  filename: text("filename").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type")
    .notNull()
    .default("application/octet-stream"),
  checksumSha256: text("checksum_sha256").notNull().default(""),
});

export const commentReads = sqliteTable(
  "comment_reads",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: integer("read_at").notNull(),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.commentId, table.userId] }),
  }),
);

export const commentReactions = sqliteTable(
  "comment_reactions",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    primary: primaryKey({
      columns: [table.commentId, table.userId, table.code],
    }),
  }),
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    readAt: integer("read_at"),
    createdAt: integer("created_at").notNull(),
    /** Set when an email digest has covered this row; in-app only until then. */
    emailedAt: integer("emailed_at"),
  },
  (table) => ({
    userIndex: index("notifications_user_idx").on(
      table.userId,
      table.readAt,
      table.id,
    ),
    // The (user_id, read_at, id) index cannot serve the id-DESC keyset used by
    // GET /notifications; this one does.
    userIdIndex: index("notifications_user_id_idx").on(table.userId, table.id),
  }),
);

export const passwordResets = sqliteTable("password_resets", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

export const notificationPreferences = sqliteTable("notification_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode", { enum: ["instant", "hourly", "daily"] })
    .notNull()
    .default("instant"),
  mutedProjectsJson: text("muted_projects_json").notNull().default("[]"),
  updatedAt: integer("updated_at").notNull(),
});

export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  kind: text("kind", { enum: ["review", "presentation"] }).notNull(),
  title: text("title").notNull(),
  layout: text("layout", { enum: ["grid", "list", "reel"] }).notNull(),
  passphraseHash: text("passphrase_hash"),
  expiresAt: integer("expires_at"),
  allowDownload: text("allow_download", {
    enum: ["none", "proxy", "original"],
  }).notNull(),
  allowComments: integer("allow_comments", { mode: "boolean" })
    .notNull()
    .default(true),
  showAllVersions: integer("show_all_versions", { mode: "boolean" })
    .notNull()
    .default(false),
  watermarkSpecJson: text("watermark_spec_json"),
  watermarkSpecHash: text("watermark_spec_hash"),
  brandJson: text("brand_json"),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  /** The 'shares' folder this share is filed in; null means directly under
      the Shares root. */
  folderId: text("folder_id").references(() => folders.id, {
    onDelete: "set null",
  }),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
});

export const shareAssets = sqliteTable(
  "share_assets",
  {
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => ({
    primary: primaryKey({ columns: [table.shareId, table.assetId] }),
  }),
);

export const shareViewers = sqliteTable(
  "share_viewers",
  {
    id: text("id").primaryKey(),
    shareId: text("share_id")
      .notNull()
      .references(() => shares.id, { onDelete: "cascade" }),
    viewerKey: text("viewer_key").notNull(),
    name: text("name"),
    email: text("email"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    userAgent: text("user_agent"),
    viewStateJson: text("view_state_json").notNull().default("{}"),
  },
  (table) => ({
    viewerUnique: unique().on(table.shareId, table.viewerKey),
  }),
);

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  eventsJson: text("events_json").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", {
      enum: ["queued", "delivering", "delivered", "failed", "dead"],
    }).notNull(),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
  },
  (table) => ({
    eventUnique: unique().on(table.webhookId, table.eventId),
  }),
);

export const exportJobs = sqliteTable("export_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  requestedBy: text("requested_by")
    .notNull()
    .references(() => users.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  format: text("format", {
    enum: [
      "resolve_edl",
      "avid_txt",
      "avid_xml",
      "xmeml",
      "fcpxml",
      "csv",
      "json",
      "text",
      "pdf",
    ],
  }).notNull(),
  filtersJson: text("filters_json").notNull().default("{}"),
  timecodeBase: text("timecode_base", {
    enum: ["source", "record_run"],
  }).notNull(),
  status: text("status", {
    enum: ["queued", "processing", "complete", "failed"],
  }).notNull(),
  resultBlobKey: text("result_blob_key"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
});

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  users: many(users),
  projects: many(projects),
  invites: many(invites),
}));
export const userRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  identities: many(identities),
  tokens: many(apiTokens),
}));
export const projectRelations = relations(projects, ({ many }) => ({
  members: many(projectMembers),
  folders: many(folders),
}));

export const schema = {
  workspaces,
  users,
  identities,
  sessions,
  invites,
  apiTokens,
  projects,
  projectMembers,
  folders,
  rateLimits,
  uploadSessions,
  uploadParts,
  assets,
  assetVersions,
  renditions,
  jobs,
  projectEvents,
  comments,
  commentAttachments,
  commentReads,
  commentReactions,
  notifications,
  notificationPreferences,
  passwordResets,
  shares,
  shareAssets,
  shareViewers,
  webhooks,
  webhookDeliveries,
  exportJobs,
  auditLog,
  appSettings,
};

export type Workspace = typeof workspaces.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
