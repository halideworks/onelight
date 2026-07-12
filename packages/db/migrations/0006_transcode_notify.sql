ALTER TABLE asset_versions ADD COLUMN failure_notified_at INTEGER;

CREATE INDEX asset_versions_failed_idx ON asset_versions(id) WHERE transcode_status = 'failed' AND failure_notified_at IS NULL;

CREATE INDEX notifications_user_id_idx ON notifications(user_id, id);
