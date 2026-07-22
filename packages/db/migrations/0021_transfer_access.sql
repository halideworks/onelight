-- Transfer access records.
--
-- A transfer knew nothing about who used it. The visitor's name lived only in
-- the grant cookie, and a download emitted a notification and a project event
-- and left no row behind, so "who has this file" was a question the system
-- could not answer an hour later. A package link handed to a client is exactly
-- the thing an owner needs an audit trail for.
--
-- These mirror share_viewers: identity by an unguessable key carried in the
-- signed cookie, first and last seen, and the user agent. The IP is separate
-- from all of it and is written only when the project asks for it
-- (settings_json.record_transfer_ips); a client-facing link that logs addresses
-- by default is a posture a self-hoster should choose, not inherit.

-- One row per person who passes the gate, per transfer.
CREATE TABLE transfer_visits (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  -- The identity in the grant cookie. Never leaves the server on the wire.
  grant_key TEXT NOT NULL,
  name TEXT NOT NULL,
  user_agent TEXT,
  -- NULL unless the project records addresses.
  ip TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX transfer_visits_grant_uq ON transfer_visits(transfer_id, grant_key);
CREATE INDEX transfer_visits_transfer_idx ON transfer_visits(transfer_id, id);

-- One row per file or archive that left, kept even after the asset is gone:
-- the filename is copied in rather than joined out, because the whole point of
-- the record is to survive what it describes.
CREATE TABLE transfer_downloads (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  visit_id TEXT REFERENCES transfer_visits(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  filename TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('file', 'zip')),
  bytes INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX transfer_downloads_transfer_idx ON transfer_downloads(transfer_id, id);
