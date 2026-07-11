-- Restore the comments self-referencing foreign keys that 0002_phase2.sql
-- shipped as bare TEXT columns: parent_id REFERENCES comments(id) ON DELETE
-- CASCADE and carried_from_comment_id REFERENCES comments(id).
--
-- SQLite cannot add foreign keys in place, so comments is rebuilt. The three
-- child tables (comment_attachments, comment_reads, comment_reactions) are
-- rebuilt too: dropping the old comments table while they still reference it
-- would run an implicit DELETE whose ON DELETE CASCADE destroys their rows.
--
-- defer_foreign_keys postpones enforcement until the surrounding transaction
-- commits (the Node runner wraps each migration file in a transaction; the
-- worker applies each migration as a single D1 batch). The copy into the new
-- comments table is additionally ordered by id (ULIDs are time ordered, and a
-- reply or carried comment is always created after its referent), so every
-- parent row is inserted before any row that references it even if a runner
-- executes statements outside a transaction.
PRAGMA defer_foreign_keys = true;

CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments_new(id) ON DELETE CASCADE,
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
  carried_from_comment_id TEXT REFERENCES comments_new(id),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);

INSERT INTO comments_new SELECT * FROM comments ORDER BY id;

CREATE TABLE comment_attachments_new (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments_new(id) ON DELETE CASCADE,
  blob_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  checksum_sha256 TEXT NOT NULL DEFAULT ''
);

INSERT INTO comment_attachments_new SELECT * FROM comment_attachments;

CREATE TABLE comment_reads_new (
  comment_id TEXT NOT NULL REFERENCES comments_new(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(comment_id, user_id)
);

INSERT INTO comment_reads_new SELECT * FROM comment_reads;

CREATE TABLE comment_reactions_new (
  comment_id TEXT NOT NULL REFERENCES comments_new(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(comment_id, user_id, code)
);

INSERT INTO comment_reactions_new SELECT * FROM comment_reactions;

DROP TABLE comment_reactions;

DROP TABLE comment_reads;

DROP TABLE comment_attachments;

DROP TABLE comments;

ALTER TABLE comments_new RENAME TO comments;

ALTER TABLE comment_attachments_new RENAME TO comment_attachments;

ALTER TABLE comment_reads_new RENAME TO comment_reads;

ALTER TABLE comment_reactions_new RENAME TO comment_reactions;

CREATE INDEX comments_version_frame_idx ON comments(version_id, deleted_at, frame_in, id);
