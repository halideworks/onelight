-- When each person last opened each project.
--
-- The projects list needs a "recent" shelf, and recency means two different
-- things at once: what the work moved on, which the project's own activity
-- already says, and what YOU were last looking at, which nothing recorded. A
-- row per person per project is the smallest thing that answers the second.
CREATE TABLE project_visits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
) WITHOUT ROWID;
--> statement-breakpoint
-- The one query it serves: this person's projects, most recently opened first.
CREATE INDEX project_visits_recent_idx ON project_visits(user_id, opened_at);
