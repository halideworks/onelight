-- Transfers: links that move files in and out of a project without a seat.
-- A package sends existing assets to someone; a request receives files from
-- someone, landing them as real assets in a chosen folder. Both kinds carry
-- the share room's protections: an unguessable slug, an optional passphrase,
-- an optional expiry, and revocation.
CREATE TABLE transfers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('package', 'request')),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  passphrase_hash TEXT,
  expires_at INTEGER,
  -- Requests only: total bytes the link may receive; NULL is unlimited.
  byte_cap INTEGER,
  -- Requests only: the folder received files land in; NULL is the root.
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX transfers_project_idx ON transfers(project_id, id);

-- The files a package delivers.
CREATE TABLE transfer_items (
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (transfer_id, asset_id)
);

-- One row per upload a request link receives: who sent it and, once the
-- upload completes and lands, which asset it became. The session reference
-- cascades because maintenance reaps stale sessions and the trash purge
-- deletes landed ones; a receipt must never block either sweep.
CREATE TABLE transfer_receipts (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  upload_session_id TEXT NOT NULL UNIQUE REFERENCES upload_sessions(id) ON DELETE CASCADE,
  sender_name TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX transfer_receipts_transfer_idx ON transfer_receipts(transfer_id, id);
