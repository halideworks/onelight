ALTER TABLE assets ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  parent_id TEXT,
  author_user_id TEXT REFERENCES users(id),
  author_name TEXT,
  author_email TEXT,
  viewer_key TEXT,
  frame_in INTEGER,
  frame_out INTEGER,
  body_text TEXT NOT NULL,
  annotation_json TEXT,
  pin_xy_json TEXT,
  page_no INTEGER,
  internal INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  completed_by TEXT REFERENCES users(id),
  carried_from_comment_id TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX comments_version_frame_idx ON comments(version_id, deleted_at, frame_in, id);

CREATE TABLE comment_attachments (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  blob_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum_sha256 TEXT NOT NULL DEFAULT ''
);

CREATE TABLE comment_reads (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(comment_id, user_id)
);

CREATE TABLE comment_reactions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(comment_id, user_id, code)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at, id);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'instant' CHECK (mode IN ('instant','hourly','daily')),
  muted_projects_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
