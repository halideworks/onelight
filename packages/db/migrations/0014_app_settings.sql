-- Instance-level settings editable from the admin UI. One row per key,
-- JSON value. First occupant: the "mail" key holding SMTP settings, which
-- take precedence over the environment when present.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
