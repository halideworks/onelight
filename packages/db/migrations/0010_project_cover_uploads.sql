-- Pictures uploaded as project covers, kept as options.
--
-- projects.cover_blob_key holds the cover in force. It cannot also be the
-- library: choosing a different cover overwrote it, so an uploaded picture
-- disappeared the moment it stopped being the current one and had to be
-- uploaded again to get it back. This table remembers each upload, so the
-- settings page can offer them all.
--
-- The chosen cover still lives on projects.cover_blob_key: this is the shelf,
-- not the pointer.
CREATE TABLE project_cover_uploads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  blob_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX project_cover_uploads_project_idx ON project_cover_uploads(project_id, id);

-- The same picture must not stack up as an option each time it is re-chosen.
CREATE UNIQUE INDEX project_cover_uploads_blob_uq ON project_cover_uploads(project_id, blob_key);
