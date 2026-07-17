import type { D1Database } from "@cloudflare/workers-types";

export interface D1Migration {
  name: string;
  /** Older tracking ids that count as this migration already being applied. */
  legacyNames?: string[];
  statements: string[];
  /**
   * Returns true when a database with no tracking rows already contains this
   * migration's schema, so the tracking row can be backfilled instead of
   * re-running the statements. This reconciles databases migrated by
   * "wrangler d1 migrations apply", which records progress in its own
   * d1_migrations table, not in __onelight_migrations.
   */
  applied: (binding: D1Database) => Promise<boolean>;
}

const tableExists = async (
  binding: D1Database,
  name: string,
): Promise<boolean> =>
  Boolean(
    await binding
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
      .bind(name)
      .first(),
  );

const commentsHaveSelfFks = async (binding: D1Database): Promise<boolean> => {
  const row = await binding
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='comments'",
    )
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes("carried_from_comment_id TEXT REFERENCES"));
};

const projectsHaveCover = async (binding: D1Database): Promise<boolean> => {
  const row = await binding
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'",
    )
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes("cover_asset_id"));
};

const usersHaveAvatarKey = async (binding: D1Database): Promise<boolean> => {
  const row = await binding
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
    )
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes("avatar_key"));
};

const usersHaveTotpSecret = async (binding: D1Database): Promise<boolean> => {
  const row = await binding
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
    )
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes("totp_secret"));
};

const projectsHaveCoverBlob = async (binding: D1Database): Promise<boolean> => {
  const row = await binding
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'",
    )
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes("cover_blob_key"));
};

const foldersHaveKind = async (binding: D1Database): Promise<boolean> => {
  const row = await binding
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='folders'",
    )
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes("kind"));
};

const assetVersionsHaveFailureNotified = async (
  binding: D1Database,
): Promise<boolean> => {
  const row = await binding
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_versions'",
    )
    .first<{ sql: string }>();
  return Boolean(row?.sql?.includes("failure_notified_at"));
};

export const d1Migrations: D1Migration[] = [
  {
    name: "0000_init.sql",
    legacyNames: ["0000_phase0.sql"],
    applied: (binding) => tableExists(binding, "workspaces"),
    statements: [
      "CREATE TABLE workspaces (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  settings_json TEXT NOT NULL DEFAULT '{}',\n  created_at INTEGER NOT NULL\n)",
      "CREATE TABLE users (\n  id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n  email TEXT NOT NULL COLLATE NOCASE,\n  name TEXT NOT NULL,\n  role TEXT NOT NULL CHECK (role IN ('admin','member')),\n  password_hash TEXT,\n  disabled_at INTEGER,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX users_email_uq ON users(workspace_id, email)",
      "CREATE TABLE identities (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  provider TEXT NOT NULL DEFAULT 'oidc',\n  subject TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX identities_subject_uq ON identities(provider, subject)",
      "CREATE TABLE sessions (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  token_hash TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,\n  last_seen_at INTEGER NOT NULL,\n  ip TEXT,\n  user_agent TEXT\n)",
      "CREATE UNIQUE INDEX sessions_token_uq ON sessions(token_hash)",
      "CREATE INDEX sessions_user_idx ON sessions(user_id)",
      "CREATE TABLE invites (\n  id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n  email TEXT NOT NULL COLLATE NOCASE,\n  role TEXT NOT NULL CHECK (role IN ('admin','member')),\n  token_hash TEXT NOT NULL,\n  invited_by TEXT NOT NULL REFERENCES users(id),\n  project_grants_json TEXT NOT NULL DEFAULT '[]',\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,\n  accepted_at INTEGER\n)",
      "CREATE UNIQUE INDEX invites_token_uq ON invites(token_hash)",
      "CREATE TABLE api_tokens (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  name TEXT NOT NULL,\n  token_hash TEXT NOT NULL,\n  token_prefix TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  last_used_at INTEGER\n)",
      "CREATE UNIQUE INDEX api_tokens_hash_uq ON api_tokens(token_hash)",
      "CREATE TABLE projects (\n  id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n  name TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),\n  palette TEXT NOT NULL,\n  restricted INTEGER NOT NULL DEFAULT 0,\n  settings_json TEXT NOT NULL DEFAULT '{}',\n  created_by TEXT NOT NULL REFERENCES users(id),\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE INDEX projects_ws_idx ON projects(workspace_id, status)",
      "CREATE TABLE project_members (\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  role TEXT NOT NULL CHECK (role IN ('manager','editor','commenter','viewer')),\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (project_id, user_id)\n)",
      "CREATE TABLE folders (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,\n  name TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX folders_sibling_uq ON folders(project_id, ifnull(parent_id,''), name)",
      "CREATE INDEX folders_parent_idx ON folders(parent_id)",
      "CREATE TABLE rate_limits (\n  key TEXT PRIMARY KEY,\n  window_start INTEGER NOT NULL,\n  count INTEGER NOT NULL\n)",
      "CREATE TABLE audit_log (\n  id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL,\n  actor_user_id TEXT,\n  action TEXT NOT NULL,\n  target TEXT,\n  meta_json TEXT NOT NULL DEFAULT '{}',\n  at INTEGER NOT NULL\n)",
      "CREATE INDEX audit_ws_at_idx ON audit_log(workspace_id, at)",
    ],
  },
  {
    name: "0001_phase1.sql",
    applied: (binding) => tableExists(binding, "jobs"),
    statements: [
      "ALTER TABLE projects ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0",
      "CREATE TABLE upload_sessions (\n  id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  created_by TEXT NOT NULL REFERENCES users(id),\n  client_filename TEXT NOT NULL,\n  relative_path TEXT NOT NULL,\n  size INTEGER NOT NULL,\n  checksum_crc32c TEXT,\n  blob_key TEXT NOT NULL,\n  upload_id TEXT,\n  part_size INTEGER,\n  status TEXT NOT NULL CHECK (status IN ('pending','uploading','completed','quarantined','aborted')),\n  created_at INTEGER NOT NULL,\n  completed_at INTEGER\n)",
      "CREATE INDEX upload_sessions_project_idx ON upload_sessions(project_id, status)",
      "CREATE TABLE upload_parts (\n  upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,\n  part_no INTEGER NOT NULL,\n  etag TEXT,\n  size INTEGER,\n  completed_at INTEGER,\n  PRIMARY KEY (upload_id, part_no)\n)",
      "CREATE TABLE assets (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,\n  name TEXT NOT NULL,\n  kind TEXT NOT NULL CHECK (kind IN ('video','audio','image','pdf','file')),\n  current_version_id TEXT,\n  status TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','in_review','approved','changes_requested')),\n  deleted_at INTEGER,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n)",
      "CREATE INDEX assets_project_idx ON assets(project_id, deleted_at, id)",
      "CREATE TABLE asset_versions (\n  id TEXT PRIMARY KEY,\n  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,\n  upload_session_id TEXT NOT NULL UNIQUE REFERENCES upload_sessions(id),\n  version_no INTEGER NOT NULL,\n  original_blob_key TEXT NOT NULL,\n  original_filename TEXT NOT NULL,\n  size INTEGER NOT NULL,\n  checksum_crc32c TEXT NOT NULL,\n  uploaded_by TEXT NOT NULL REFERENCES users(id),\n  media_info_json TEXT NOT NULL DEFAULT '{}',\n  source_timecode_start TEXT,\n  source_start_frame INTEGER,\n  frame_rate_num INTEGER,\n  frame_rate_den INTEGER,\n  drop_frame INTEGER,\n  duration_frames INTEGER,\n  color_json TEXT NOT NULL DEFAULT '{}',\n  transcode_status TEXT NOT NULL DEFAULT 'pending' CHECK (transcode_status IN ('pending','processing','ready','failed','skipped')),\n  deleted_at INTEGER,\n  created_at INTEGER NOT NULL,\n  UNIQUE(asset_id, version_no)\n)",
      "CREATE INDEX asset_versions_asset_idx ON asset_versions(asset_id, version_no)",
      "CREATE TABLE renditions (\n  id TEXT PRIMARY KEY,\n  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,\n  kind TEXT NOT NULL CHECK (kind IN ('proxy_2160','proxy_1080','proxy_540','hdr_hevc','hdr_av1','audio_peaks','sprite','poster','pdf_pages','still_tiles','watermarked')),\n  blob_key TEXT NOT NULL,\n  meta_json TEXT NOT NULL DEFAULT '{}',\n  size INTEGER NOT NULL DEFAULT 0,\n  checksum_sha256 TEXT NOT NULL DEFAULT '',\n  share_id TEXT,\n  created_at INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX renditions_base_uq ON renditions(version_id, kind) WHERE share_id IS NULL",
      "CREATE UNIQUE INDEX renditions_share_uq ON renditions(version_id, kind, share_id) WHERE share_id IS NOT NULL",
      "CREATE TABLE jobs (\n  id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL UNIQUE,\n  status TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed','dead')),\n  priority INTEGER NOT NULL DEFAULT 0,\n  capability_json TEXT NOT NULL DEFAULT '{}',\n  max_attempts INTEGER NOT NULL DEFAULT 5,\n  attempts INTEGER NOT NULL DEFAULT 0,\n  run_after INTEGER NOT NULL,\n  created_at INTEGER NOT NULL,\n  started_at INTEGER,\n  heartbeat_at INTEGER,\n  lease_expires_at INTEGER,\n  finished_at INTEGER,\n  error TEXT,\n  worker_id TEXT\n)",
      "CREATE INDEX jobs_claim_idx ON jobs(status, run_after)",
      "CREATE TABLE project_events (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  type TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n)",
      "CREATE INDEX project_events_replay_idx ON project_events(project_id, id)",
    ],
  },
  {
    name: "0002_phase2.sql",
    applied: (binding) => tableExists(binding, "comments"),
    statements: [
      "ALTER TABLE assets ADD COLUMN description TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE assets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'",
      "CREATE TABLE comments (\n  id TEXT PRIMARY KEY,\n  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,\n  parent_id TEXT,\n  author_user_id TEXT REFERENCES users(id),\n  author_name TEXT,\n  author_email TEXT,\n  viewer_key TEXT,\n  frame_in INTEGER,\n  frame_out INTEGER,\n  body_text TEXT NOT NULL,\n  annotation_json TEXT,\n  pin_xy_json TEXT,\n  page_no INTEGER,\n  internal INTEGER NOT NULL DEFAULT 0,\n  completed_at INTEGER,\n  completed_by TEXT REFERENCES users(id),\n  carried_from_comment_id TEXT,\n  deleted_at INTEGER,\n  created_at INTEGER NOT NULL,\n  edited_at INTEGER\n)",
      "CREATE INDEX comments_version_frame_idx ON comments(version_id, deleted_at, frame_in, id)",
      "CREATE TABLE comment_attachments (\n  id TEXT PRIMARY KEY,\n  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,\n  blob_key TEXT NOT NULL,\n  filename TEXT NOT NULL,\n  size INTEGER NOT NULL,\n  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',\n  checksum_sha256 TEXT NOT NULL DEFAULT ''\n)",
      "CREATE TABLE comment_reads (\n  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  read_at INTEGER NOT NULL,\n  PRIMARY KEY(comment_id, user_id)\n)",
      "CREATE TABLE comment_reactions (\n  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  code TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(comment_id, user_id, code)\n)",
      "CREATE TABLE notifications (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  kind TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  read_at INTEGER,\n  created_at INTEGER NOT NULL\n)",
      "CREATE INDEX notifications_user_idx ON notifications(user_id, read_at, id)",
      "CREATE TABLE notification_preferences (\n  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,\n  mode TEXT NOT NULL DEFAULT 'instant' CHECK (mode IN ('instant','hourly','daily')),\n  muted_projects_json TEXT NOT NULL DEFAULT '[]',\n  updated_at INTEGER NOT NULL\n)",
    ],
  },
  {
    name: "0003_phase3.sql",
    applied: (binding) => tableExists(binding, "shares"),
    statements: [
      "CREATE TABLE shares (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  slug TEXT NOT NULL UNIQUE,\n  kind TEXT NOT NULL CHECK (kind IN ('review','presentation')),\n  title TEXT NOT NULL,\n  layout TEXT NOT NULL CHECK (layout IN ('grid','list','reel')),\n  passphrase_hash TEXT,\n  expires_at INTEGER,\n  allow_download TEXT NOT NULL CHECK (allow_download IN ('none','proxy','original')),\n  allow_comments INTEGER NOT NULL DEFAULT 1,\n  show_all_versions INTEGER NOT NULL DEFAULT 0,\n  watermark_spec_json TEXT,\n  watermark_spec_hash TEXT,\n  brand_json TEXT,\n  created_by TEXT NOT NULL REFERENCES users(id),\n  revoked_at INTEGER,\n  created_at INTEGER NOT NULL\n)",
      "CREATE TABLE share_assets (\n  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,\n  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,\n  sort_order INTEGER NOT NULL,\n  PRIMARY KEY(share_id, asset_id)\n)",
      "CREATE TABLE share_viewers (\n  id TEXT PRIMARY KEY,\n  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,\n  viewer_key TEXT NOT NULL,\n  name TEXT,\n  email TEXT,\n  first_seen_at INTEGER NOT NULL,\n  last_seen_at INTEGER NOT NULL,\n  user_agent TEXT,\n  view_state_json TEXT NOT NULL DEFAULT '{}',\n  UNIQUE(share_id, viewer_key)\n)",
      "CREATE TABLE webhooks (\n  id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n  url TEXT NOT NULL,\n  secret TEXT NOT NULL,\n  events_json TEXT NOT NULL,\n  active INTEGER NOT NULL DEFAULT 1,\n  created_at INTEGER NOT NULL\n)",
      "CREATE TABLE webhook_deliveries (\n  id TEXT PRIMARY KEY,\n  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,\n  event_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  status TEXT NOT NULL CHECK (status IN ('queued','delivering','delivered','failed','dead')),\n  attempt INTEGER NOT NULL DEFAULT 0,\n  next_attempt_at INTEGER NOT NULL,\n  response_status INTEGER,\n  response_body TEXT,\n  created_at INTEGER NOT NULL,\n  delivered_at INTEGER,\n  UNIQUE(webhook_id, event_id)\n)",
      "CREATE TABLE export_jobs (\n  id TEXT PRIMARY KEY,\n  workspace_id TEXT NOT NULL REFERENCES workspaces(id),\n  requested_by TEXT NOT NULL REFERENCES users(id),\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  format TEXT NOT NULL CHECK (format IN ('resolve_edl','avid_txt','avid_xml','xmeml','fcpxml','csv','json','text','pdf')),\n  filters_json TEXT NOT NULL DEFAULT '{}',\n  timecode_base TEXT NOT NULL CHECK (timecode_base IN ('source','record_run')),\n  status TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed')),\n  result_blob_key TEXT,\n  error TEXT,\n  created_at INTEGER NOT NULL,\n  finished_at INTEGER\n)",
    ],
  },
  {
    name: "0004_comments_fks.sql",
    applied: commentsHaveSelfFks,
    statements: [
      "PRAGMA defer_foreign_keys = true",
      "CREATE TABLE comments_new (\n  id TEXT PRIMARY KEY,\n  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,\n  parent_id TEXT REFERENCES comments_new(id) ON DELETE CASCADE,\n  author_user_id TEXT REFERENCES users(id),\n  author_name TEXT,\n  author_email TEXT,\n  viewer_key TEXT,\n  frame_in INTEGER,\n  frame_out INTEGER,\n  body_text TEXT NOT NULL,\n  annotation_json TEXT,\n  pin_xy_json TEXT,\n  page_no INTEGER,\n  internal INTEGER NOT NULL DEFAULT 0,\n  completed_at INTEGER,\n  completed_by TEXT REFERENCES users(id),\n  carried_from_comment_id TEXT REFERENCES comments_new(id),\n  deleted_at INTEGER,\n  created_at INTEGER NOT NULL,\n  edited_at INTEGER\n)",
      "INSERT INTO comments_new SELECT * FROM comments ORDER BY id",
      "CREATE TABLE comment_attachments_new (\n  id TEXT PRIMARY KEY,\n  comment_id TEXT NOT NULL REFERENCES comments_new(id) ON DELETE CASCADE,\n  blob_key TEXT NOT NULL,\n  filename TEXT NOT NULL,\n  size INTEGER NOT NULL,\n  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',\n  checksum_sha256 TEXT NOT NULL DEFAULT ''\n)",
      "INSERT INTO comment_attachments_new SELECT * FROM comment_attachments",
      "CREATE TABLE comment_reads_new (\n  comment_id TEXT NOT NULL REFERENCES comments_new(id) ON DELETE CASCADE,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  read_at INTEGER NOT NULL,\n  PRIMARY KEY(comment_id, user_id)\n)",
      "INSERT INTO comment_reads_new SELECT * FROM comment_reads",
      "CREATE TABLE comment_reactions_new (\n  comment_id TEXT NOT NULL REFERENCES comments_new(id) ON DELETE CASCADE,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  code TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY(comment_id, user_id, code)\n)",
      "INSERT INTO comment_reactions_new SELECT * FROM comment_reactions",
      "DROP TABLE comment_reactions",
      "DROP TABLE comment_reads",
      "DROP TABLE comment_attachments",
      "DROP TABLE comments",
      "ALTER TABLE comments_new RENAME TO comments",
      "ALTER TABLE comment_attachments_new RENAME TO comment_attachments",
      "ALTER TABLE comment_reads_new RENAME TO comment_reads",
      "ALTER TABLE comment_reactions_new RENAME TO comment_reactions",
      "CREATE INDEX comments_version_frame_idx ON comments(version_id, deleted_at, frame_in, id)",
    ],
  },
  {
    name: "0005_password_resets.sql",
    applied: (binding) => tableExists(binding, "password_resets"),
    statements: [
      "CREATE TABLE password_resets (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,\n  token_hash TEXT NOT NULL UNIQUE,\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL,\n  used_at INTEGER\n)",
      "ALTER TABLE notifications ADD COLUMN emailed_at INTEGER",
    ],
  },
  {
    name: "0006_transcode_notify.sql",
    applied: assetVersionsHaveFailureNotified,
    statements: [
      "ALTER TABLE asset_versions ADD COLUMN failure_notified_at INTEGER",
      "CREATE INDEX asset_versions_failed_idx ON asset_versions(id) WHERE transcode_status = 'failed' AND failure_notified_at IS NULL",
      "CREATE INDEX notifications_user_id_idx ON notifications(user_id, id)",
    ],
  },
  {
    name: "0007_project_cover.sql",
    applied: projectsHaveCover,
    statements: ["ALTER TABLE projects ADD COLUMN cover_asset_id TEXT"],
  },
  {
    name: "0008_project_cover_blob.sql",
    applied: projectsHaveCoverBlob,
    statements: ["ALTER TABLE projects ADD COLUMN cover_blob_key TEXT"],
  },
  {
    name: "0009_share_folders.sql",
    applied: foldersHaveKind,
    statements: [
      "ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'assets'",
      "ALTER TABLE shares ADD COLUMN folder_id TEXT",
      "DROP INDEX IF EXISTS folders_sibling_uq",
      "CREATE UNIQUE INDEX folders_sibling_uq ON folders(project_id, kind, ifnull(parent_id, ''), name)",
    ],
  },
  {
    name: "0010_project_cover_uploads.sql",
    applied: (binding) => tableExists(binding, "project_cover_uploads"),
    statements: [
      "CREATE TABLE project_cover_uploads (\n  id TEXT PRIMARY KEY,\n  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n  blob_key TEXT NOT NULL,\n  filename TEXT NOT NULL,\n  created_by TEXT NOT NULL REFERENCES users(id),\n  created_at INTEGER NOT NULL\n)",
      "CREATE INDEX project_cover_uploads_project_idx ON project_cover_uploads(project_id, id)",
      "CREATE UNIQUE INDEX project_cover_uploads_blob_uq ON project_cover_uploads(project_id, blob_key)",
    ],
  },
  {
    name: "0011_user_avatars.sql",
    applied: usersHaveAvatarKey,
    statements: ["ALTER TABLE users ADD COLUMN avatar_key TEXT"],
  },
  {
    name: "0012_caption_tracks.sql",
    applied: (binding) => tableExists(binding, "caption_tracks"),
    statements: [
      "CREATE TABLE caption_tracks (\n  id TEXT PRIMARY KEY,\n  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,\n  language TEXT NOT NULL,\n  label TEXT NOT NULL,\n  blob_key TEXT NOT NULL,\n  created_by TEXT NOT NULL REFERENCES users(id),\n  created_at INTEGER NOT NULL\n)",
      "CREATE UNIQUE INDEX caption_tracks_version_lang_uq ON caption_tracks(version_id, language)",
    ],
  },
  {
    name: "0013_user_totp.sql",
    applied: usersHaveTotpSecret,
    statements: [
      "ALTER TABLE users ADD COLUMN totp_secret TEXT",
      "ALTER TABLE users ADD COLUMN totp_verified_at INTEGER",
      "ALTER TABLE users ADD COLUMN totp_backup_codes_json TEXT NOT NULL DEFAULT '[]'",
    ],
  },
];

const migrate = async (binding: D1Database): Promise<void> => {
  await binding
    .prepare(
      "CREATE TABLE IF NOT EXISTS __onelight_migrations (id TEXT PRIMARY KEY)",
    )
    .run();
  const trackedRows = await binding
    .prepare("SELECT id FROM __onelight_migrations")
    .all<{ id: string }>();
  const tracked = new Set(trackedRows.results.map((row) => row.id));
  if (tracked.size === 0 && (await tableExists(binding, "workspaces"))) {
    // The schema exists but nothing is tracked: the operator applied
    // migrations through wrangler. Backfill tracking rows for every
    // migration whose schema is already present instead of re-running.
    for (const migration of d1Migrations) {
      if (!(await migration.applied(binding))) break;
      await binding
        .prepare("INSERT INTO __onelight_migrations (id) VALUES (?)")
        .bind(migration.name)
        .run();
      tracked.add(migration.name);
    }
  }
  for (const migration of d1Migrations) {
    if (tracked.has(migration.name)) continue;
    if (migration.legacyNames?.some((name) => tracked.has(name))) continue;
    // The tracking INSERT rides in the same batch (one transaction), so a
    // mid-migration failure leaves neither half-applied schema nor a stale
    // tracking row.
    await binding.batch([
      ...migration.statements.map((statement) => binding.prepare(statement)),
      binding
        .prepare("INSERT INTO __onelight_migrations (id) VALUES (?)")
        .bind(migration.name),
    ]);
  }
};

const inFlight = new WeakMap<D1Database, Promise<void>>();

/**
 * Apply pending migrations once per isolate and binding. Repeat calls reuse
 * the same promise instead of re-querying D1 on every request; a failed run
 * is forgotten so the next request can retry.
 */
export const applyD1Migrations = (binding: D1Database): Promise<void> => {
  const memoized = inFlight.get(binding);
  if (memoized) return memoized;
  const run = migrate(binding).catch((error: unknown) => {
    inFlight.delete(binding);
    throw error;
  });
  inFlight.set(binding, run);
  return run;
};
