CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('review','presentation')),
  title TEXT NOT NULL,
  layout TEXT NOT NULL CHECK (layout IN ('grid','list','reel')),
  passphrase_hash TEXT,
  expires_at INTEGER,
  allow_download TEXT NOT NULL CHECK (allow_download IN ('none','proxy','original')),
  allow_comments INTEGER NOT NULL DEFAULT 1,
  show_all_versions INTEGER NOT NULL DEFAULT 0,
  watermark_spec_json TEXT,
  watermark_spec_hash TEXT,
  brand_json TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE share_assets (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(share_id, asset_id)
);

CREATE TABLE share_viewers (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  viewer_key TEXT NOT NULL,
  name TEXT,
  email TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  view_state_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(share_id, viewer_key)
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','delivering','delivered','failed','dead')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE(webhook_id, event_id)
);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('resolve_edl','avid_txt','avid_xml','xmeml','fcpxml','csv','json','text','pdf')),
  filters_json TEXT NOT NULL DEFAULT '{}',
  timecode_base TEXT NOT NULL CHECK (timecode_base IN ('source','record_run')),
  status TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed')),
  result_blob_key TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
