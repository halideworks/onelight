-- Notification email, told what to send and when.
--
-- One dial for everything is why people turn all of it off: a mention and a new
-- version arriving are not the same news, and a "daily" summary that arrives at
-- whatever hour the first unread row happened to land is not a habit anybody can
-- build around. So: per-kind routing, an hour to send the daily one at in the
-- reader's own day, and an "off" that a one-click unsubscribe can set.
--
-- The table is rebuilt rather than altered because "off" has to join the CHECK
-- on mode, and SQLite cannot alter a constraint.
CREATE TABLE notification_preferences_new (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'instant' CHECK (mode IN ('off','instant','hourly','daily')),
  kind_modes_json TEXT NOT NULL DEFAULT '{}',
  digest_hour INTEGER NOT NULL DEFAULT 8,
  utc_offset_minutes INTEGER NOT NULL DEFAULT 0,
  last_daily_digest_at INTEGER,
  muted_projects_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO notification_preferences_new (user_id, mode, muted_projects_json, updated_at)
SELECT user_id, mode, muted_projects_json, updated_at FROM notification_preferences;
--> statement-breakpoint
DROP TABLE notification_preferences;
--> statement-breakpoint
ALTER TABLE notification_preferences_new RENAME TO notification_preferences;
