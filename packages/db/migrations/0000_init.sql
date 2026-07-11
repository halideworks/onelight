CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  password_hash TEXT,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_email_uq ON users(workspace_id, email);

CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'oidc',
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX identities_subject_uq ON identities(provider, subject);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE UNIQUE INDEX sessions_token_uq ON sessions(token_hash);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  project_grants_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER
);
CREATE UNIQUE INDEX invites_token_uq ON invites(token_hash);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX api_tokens_hash_uq ON api_tokens(token_hash);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  palette TEXT NOT NULL,
  restricted INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX projects_ws_idx ON projects(workspace_id, status);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('manager','editor','commenter','viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX folders_sibling_uq ON folders(project_id, ifnull(parent_id,''), name);
CREATE INDEX folders_parent_idx ON folders(parent_id);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL
);
CREATE INDEX audit_ws_at_idx ON audit_log(workspace_id, at);
