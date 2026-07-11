ALTER TABLE projects ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  client_filename TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum_crc32c TEXT,
  blob_key TEXT NOT NULL,
  upload_id TEXT,
  part_size INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','uploading','completed','quarantined','aborted')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX upload_sessions_project_idx ON upload_sessions(project_id, status);

CREATE TABLE upload_parts (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_no INTEGER NOT NULL,
  etag TEXT,
  size INTEGER,
  completed_at INTEGER,
  PRIMARY KEY (upload_id, part_no)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video','audio','image','pdf','file')),
  current_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','in_review','approved','changes_requested')),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX assets_project_idx ON assets(project_id, deleted_at, id);

CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  upload_session_id TEXT NOT NULL UNIQUE REFERENCES upload_sessions(id),
  version_no INTEGER NOT NULL,
  original_blob_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum_crc32c TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  media_info_json TEXT NOT NULL DEFAULT '{}',
  source_timecode_start TEXT,
  source_start_frame INTEGER,
  frame_rate_num INTEGER,
  frame_rate_den INTEGER,
  drop_frame INTEGER,
  duration_frames INTEGER,
  color_json TEXT NOT NULL DEFAULT '{}',
  transcode_status TEXT NOT NULL DEFAULT 'pending' CHECK (transcode_status IN ('pending','processing','ready','failed','skipped')),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(asset_id, version_no)
);
CREATE INDEX asset_versions_asset_idx ON asset_versions(asset_id, version_no);

CREATE TABLE renditions (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('proxy_2160','proxy_1080','proxy_540','hdr_hevc','hdr_av1','audio_peaks','sprite','poster','pdf_pages','still_tiles','watermarked')),
  blob_key TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  size INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT NOT NULL DEFAULT '',
  share_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX renditions_base_uq ON renditions(version_id, kind) WHERE share_id IS NULL;
CREATE UNIQUE INDEX renditions_share_uq ON renditions(version_id, kind, share_id) WHERE share_id IS NOT NULL;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed','dead')),
  priority INTEGER NOT NULL DEFAULT 0,
  capability_json TEXT NOT NULL DEFAULT '{}',
  max_attempts INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  heartbeat_at INTEGER,
  lease_expires_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  worker_id TEXT
);
CREATE INDEX jobs_claim_idx ON jobs(status, run_after);

CREATE TABLE project_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX project_events_replay_idx ON project_events(project_id, id);
