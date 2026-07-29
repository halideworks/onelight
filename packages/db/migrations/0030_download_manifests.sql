-- A delivery is chosen, then downloaded.
--
-- The selection zip passed its asset ids in the query string, which is about
-- 81 KB of URL for 3000 files: fine on Caddy, refused by an nginx default and
-- by the Cloudflare 16 KB URL cap. A manifest is POSTed once and downloaded by
-- a short token, which also lets one selection be served as several archives.
CREATE TABLE download_manifests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT '',
  asset_ids_json TEXT NOT NULL DEFAULT '[]',
  folder_id TEXT,
  part_bytes INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX download_manifests_project_idx ON download_manifests(project_id, id);
