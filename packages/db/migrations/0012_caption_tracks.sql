-- Caption sidecars for a version: a WebVTT file per language, uploaded
-- through the captions endpoint (by hand or by a deployment's captioning
-- hook). Separate from renditions because the pipeline never makes these;
-- people and hooks do.
CREATE TABLE caption_tracks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  label TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX caption_tracks_version_lang_uq ON caption_tracks(version_id, language);
