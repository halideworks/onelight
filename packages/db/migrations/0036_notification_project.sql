-- Which project a notification is about, as a column rather than a fact buried
-- in its payload JSON.
--
-- The badge on a project card was counted in the browser from the newest page
-- of notifications, so a project whose unread rows had fallen past that page
-- showed no badge at all. A count has to come from the server, and to be
-- counted cheaply it has to be indexed, which JSON cannot be.
ALTER TABLE asset_versions ADD COLUMN transcode_error TEXT;
--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN project_id TEXT;
--> statement-breakpoint
UPDATE notifications
SET project_id = json_extract(payload_json, '$.project_id')
WHERE project_id IS NULL AND json_valid(payload_json);
--> statement-breakpoint
-- The one query it serves: this person's unread rows, grouped by project.
CREATE INDEX notifications_project_unread_idx
  ON notifications(user_id, read_at, project_id);
