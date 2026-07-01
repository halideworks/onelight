# Onelight Phase 0 Implementation Spec

Foundations: monorepo, core ports, database, auth (password + OIDC), workspace/project/folder/member CRUD, SPA shell in the established design language, Docker deployment, CI running the contract suite on both Node/SQLite and Workers/D1.

This document is written to be executed without further product decisions. Where it is silent, follow `onelight_design_doc.md` (the design doc) and `reviewer/mockups/` (the visual reference). Rules that apply to every line produced: no emojis, no em dashes, match the design doc's terminology.

Milestone (from design doc Phase 0): `docker compose up`, log in via password and via OIDC, create a project, invite a member.

## 0. Non-goals for this phase

No uploads, no media, no jobs/workers, no comments, no shares, no realtime, no email sending (invites surface a copyable link), no Cloudflare deploy button (the CF target only has to pass tests in CI), no passkeys.

## 1. Toolchain and conventions

| Item | Decision |
|---|---|
| Runtime | Node >= 22 LTS (Bun compatible but Node is CI truth); Workers via wrangler 4 |
| Package manager | pnpm 9, workspaces |
| Language | TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess: true`, ESM only |
| API framework | Hono ^4 + `@hono/zod-openapi` |
| Validation | zod ^3 (single source for validation, OpenAPI, and client types) |
| ORM | drizzle-orm + drizzle-kit, SQLite dialect only |
| SQLite drivers | better-sqlite3 (Node), D1 binding (Workers) |
| Frontend | SvelteKit ^2, Svelte 5 runes, adapter-static, TypeScript |
| Tests | vitest ^3; `@cloudflare/vitest-pool-workers` for the D1 run; Playwright deferred to Phase 2 |
| Lint/format | eslint 9 flat config + prettier; no warnings allowed in CI |
| IDs | ULID (ulidx, monotonic factory), stored as 26-char TEXT, lowercase field name `id` |
| Time | INTEGER epoch milliseconds UTC everywhere; column suffix `_at` |
| JSON columns | TEXT with `_json` suffix, parsed/validated at the edge with zod |
| Crypto | WebCrypto API only in shared code (works on both runtimes); `jose` for JWT/JWKS |
| License | AGPL-3.0-only, SPDX headers not required, LICENSE file at root |

Naming: snake_case in SQL and JSON wire format, camelCase in TypeScript. The zod schemas define the wire format; a shared `toWire`/`fromWire` mapping layer is not built, Drizzle column aliases handle it.

### Error envelope (every non-2xx response)

```json
{ "error": { "code": "invalid_credentials", "message": "Email or password is incorrect.", "details": {} } }
```

`code` is machine-stable snake_case; `message` is human-readable, sentence case, period; `details` optional structured context (e.g. zod issues under `details.issues`). Canonical codes used in this phase: `validation_failed` (400), `unauthorized` (401), `invalid_credentials` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `rate_limited` (429), `internal` (500). Validation failures always echo zod issues.

### Pagination

List endpoints accept `?limit` (default 50, max 200) and `?cursor` (opaque). Response shape: `{ "items": [...], "next_cursor": "..." | null }`. Cursor is the base64url of the last item's ULID; ordering is `id DESC` (ULIDs sort by creation time) unless the endpoint says otherwise.

## 2. Repository layout

```
onelight/
  package.json            # workspace root, scripts: dev, build, test, lint, typecheck
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.js
  LICENSE                 # AGPL-3.0
  README.md
  packages/
    core/                 # runtime-agnostic domain (minimal deps: zod, ulidx): ids, time, errors, ports, permissions, palettes
    db/                   # drizzle schema, migrations, migrate runners
    api/                  # hono app factory, routes, middleware; platform-agnostic
    web/                  # sveltekit SPA
  apps/
    server/               # node entry: api + static SPA + local adapters; Dockerfile
    cf/                   # workers entry: wrangler.jsonc, D1 config, workers adapters
  deploy/
    docker-compose.yml
    Caddyfile.example
  specs/
    phase-0.md            # this file
  mockups/                # design reference (already present)
```

`packages/api` never imports platform modules (`node:*`, better-sqlite3, D1 types) directly; everything platform-specific arrives through an `Env` object built by the app entrypoints:

```ts
// packages/core/src/ports.ts (Phase 0 surface; BlobStore/JobQueue/Transcoder/RealtimeHub are
// declared here as interfaces now, implemented in Phase 1+)
export interface PasswordHasher {
  hash(plain: string): Promise<string>          // self-describing PHC string
  verify(plain: string, stored: string): Promise<boolean>
}
export interface Clock { now(): number }
export interface IdGen { ulid(): string }
export interface AppEnv {
  db: DrizzleDb
  hasher: PasswordHasher
  clock: Clock
  ids: IdGen
  config: AppConfig
}
```

## 3. Configuration

Environment variables (all consumed in one `loadConfig()` with zod validation; startup fails loudly on invalid config):

| Var | Required | Default | Notes |
|---|---|---|---|
| `PUBLIC_URL` | yes | - | e.g. `https://review.studio.com`; used for cookies, OIDC redirect, origin checks. Compose ships `http://localhost:3000` |
| `PORT` / `HOST` | no | `3000` / `0.0.0.0` | node listener |
| `DATABASE_PATH` | node only | `/data/onelight.db` | SQLite file; opened with WAL and `PRAGMA foreign_keys=ON` |
| `SECRET_KEY` | yes | - | >= 32 chars; the app-wide HMAC key (OIDC state cookie now, signed media URLs in Phase 1); refuse to boot without it |
| `ONELIGHT_ADMIN_EMAIL` / `ONELIGHT_ADMIN_PASSWORD` | no | - | headless first-run (Node boot only; on Workers `/setup` is the only path): creates workspace + admin if no users exist |
| `ONELIGHT_WORKSPACE_NAME` | no | `Onelight` | workspace name for headless first-run |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | no | - | enables SSO when all present |
| `OIDC_AUTO_PROVISION` | no | `false` | create users on first OIDC login |
| `OIDC_ALLOWED_DOMAINS` | no | - | comma list; constrains auto-provision |
| `COOKIE_SECURE` | no | auto | `true` iff `PUBLIC_URL` scheme is `https` |
| `TRUST_PROXY` | no | `false` | when true, client IP = rightmost `X-Forwarded-For` hop; on Workers always `CF-Connecting-IP`. When false, socket address |

On Workers these arrive as bindings/secrets; same names.

## 4. Database

Full DDL for Phase 0 (expressed here as SQL; implemented as Drizzle schema in `packages/db/src/schema.ts` with drizzle-kit generating migrations that match this exactly). All tables ULID TEXT PKs, epoch-ms INTEGER times.

```sql
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
  password_hash TEXT,                -- NULL for OIDC-only accounts
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_email_uq ON users(workspace_id, email);

CREATE TABLE identities (             -- external auth identities (OIDC)
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'oidc',
  subject TEXT NOT NULL,             -- iss 'sub' claim
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX identities_subject_uq ON identities(provider, subject);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,          -- sha256(base64url token), hex
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT, user_agent TEXT
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
  project_grants_json TEXT NOT NULL DEFAULT '[]',   -- [{project_id, role}]
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,       -- created_at + 7 days
  accepted_at INTEGER
);
CREATE UNIQUE INDEX invites_token_uq ON invites(token_hash);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,          -- sha256 of full token
  token_prefix TEXT NOT NULL,        -- first 12 chars for display: olt_ab12cd34
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX api_tokens_hash_uq ON api_tokens(token_hash);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  palette TEXT NOT NULL,             -- palette key from the gradient library, e.g. 'sumimai'
  restricted INTEGER NOT NULL DEFAULT 0,  -- 1 = invite-only, invisible to non-members
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
  key TEXT PRIMARY KEY,              -- '<bucket>:<subject>', e.g. 'login:ip:1.2.3.4'
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_user_id TEXT,                -- NULL for system
  action TEXT NOT NULL,              -- e.g. 'user.login', 'project.create'
  target TEXT,                       -- '<type>:<id>'
  meta_json TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL
);
CREATE INDEX audit_ws_at_idx ON audit_log(workspace_id, at);
```

Rules:
- Foreign keys are enforced on both runtimes: Node opens every connection with `PRAGMA foreign_keys=ON` (D1 enforces by default). A contract test asserts FK enforcement on both.
- Folder depth cap: 10. Enforced in the service layer on create/move (walk ancestors). Folder moves must stay within the folder's project (400 `validation_failed` otherwise).
- Folder rename collisions return `conflict`.
- Exactly one workspace row exists in Phase 0 (created at first run); all queries still filter by `workspace_id`.
- Concurrency posture: D1 has no interactive transactions (batch only), so nothing may rely on multi-statement transactions. Invariant guards (last admin, last manager, sibling uniqueness) are enforced by unique indexes and single conditional statements (`UPDATE ... WHERE (SELECT ...)`); residual check-then-act races are acceptable in Phase 0 given SQLite's single writer.
- Migrations: drizzle-kit generated SQL committed to `packages/db/migrations/`; hand-editing a generated migration is permitted where drizzle-kit cannot express the DDL (the `folders_sibling_uq` expression index is the known case); the §4 DDL is the source of truth and the drift test enforces it. `wrangler.jsonc` points `migrations_dir` at the same folder (a post-generate script verifies statements are D1-safe and strips drizzle breakpoint comments if present). Node uses drizzle `migrate()` on boot; each runner keeps its own tracking table. Schema drift between the two paths is a CI failure (a test dumps `sqlite_master` from both and diffs normalized DDL).
- This spec intentionally supersedes the design doc's §5 sketch in two places: `users.oidc_sub` is replaced by the `identities` table, and `api_tokens.scopes` is deferred (tokens carry their user's permissions).
- Expired-row hygiene: expired sessions are deleted opportunistically when touched by auth middleware; expired invites at lookup/accept; full background sweeps arrive with the Phase 1 job system.

## 5. Auth design

### Passwords

`PasswordHasher` port, PHC-format self-describing strings, verify dispatches on prefix. Workers cannot run argon2 (workerd blocks runtime WASM compilation and WebCrypto has no argon2), so the portability rule is:
- Universal format both runtimes create AND verify: WebCrypto PBKDF2-SHA256, **100,000 iterations** (the Workers platform cap), 16-byte salt, `$pbkdf2-sha256$i=100000$<b64salt>$<b64hash>`.
- Node-only upgrade: new hashes on Node use `@node-rs/argon2`, argon2id, m=19456 KiB, t=2, p=1; Node verifies both formats. Workers verifies PBKDF2 only.
- Documented consequence: migrating a database from a Node deployment to Workers requires password resets for argon2 users (OIDC users unaffected). The importer (Phase 6 CLI) will warn.
- PBKDF2-100k is acceptable here because login is rate-limited and the minimum length is 10; argon2id remains the self-hosted default.
- Password policy: length >= 10, no other composition rules; reject top-10k common passwords (embedded list).
- Edge cases: login for a disabled user returns `invalid_credentials` (no account-state leak). `PATCH /users/me` password change requires `current` unless `password_hash IS NULL` (OIDC-only account setting its first password). A successful password change deletes all of the user's other sessions.

### Sessions

- Token: 32 random bytes, base64url, sent as cookie `ol_session`; DB stores hex SHA-256 only.
- Cookie: `HttpOnly; SameSite=Lax; Path=/; Secure` (per COOKIE_SECURE); max-age 30 days.
- Sliding expiry: on authenticated requests where `last_seen_at` is older than 24h, bump `last_seen_at` and `expires_at = now + 30d`, and re-send `Set-Cookie` with a fresh Max-Age (otherwise the browser expires the cookie while the row lives).
- CSRF: mutating requests (POST/PATCH/PUT/DELETE) with cookie auth must present an `Origin` (or `Referer`) whose origin equals `PUBLIC_URL`'s; otherwise 403 `forbidden`. Bearer-token requests are exempt.
- Logout deletes the session row and clears the cookie.

### API tokens

`olt_` + 32 bytes base62. Shown once at creation. `Authorization: Bearer olt_...`. Token auth resolves to its user and carries the user's permissions. `last_used_at` updated at most once per hour.

### Rate limiting

Fixed-window counters in the `rate_limits` table (portable; Workers KV not required at this scale): `login` 10/5min per email and per IP; `invite_accept`, `invite_lookup`, and `oidc_callback` 20/5min per IP. Exceed returns 429 `rate_limited` with `Retry-After`. Rows with `window_start` older than the window are deleted opportunistically on increment. Client IP resolution per the `TRUST_PROXY` rule in §3.

### OIDC (single provider)

Authorization code + PKCE (S256) + nonce. No SDK; discovery document fetched from `OIDC_ISSUER/.well-known/openid-configuration` and cached 1h; ID token verified with `jose` against the JWKS.
- `GET /api/v1/auth/oidc/start` stores `{state, code_verifier, nonce}` in cookie `ol_oidc`: a compact HS256 JWS (jose) signed with `SECRET_KEY`, Max-Age 600, HttpOnly, SameSite=Lax (Lax cookies ride the top-level callback navigation). 302 to the authorization endpoint with `scope=openid email profile`.
- `GET /api/v1/auth/oidc/callback` validates state, exchanges code, verifies ID token (`iss`, `aud`, `exp`, `nonce`), then: match `identities(provider,subject)`; else match user by email ONLY when `email_verified === true` (absent or false claim: no email match) and link identity; else auto-provision when enabled and domain allowed (role `member`, name = `name` claim, else email local part); else 403 `forbidden`. On success create a session, clear `ol_oidc`, 302 to `/`.

### First run

If `users` is empty: API exposes `POST /api/v1/setup` (workspace name, admin name/email/password) and the SPA routes to `/setup`. On Node, if the `ONELIGHT_ADMIN_*` env vars are present at boot, setup runs headlessly (workspace name from `ONELIGHT_WORKSPACE_NAME`). On Workers there is no boot hook; `/setup` is the only first-run path. `setup` is 404 once any user exists.

Recovery: `apps/server` ships an admin CLI, `node cli.js reset-password <email>`, which sets a printed one-time password and revokes the user's sessions (locked-out-admin escape hatch until the emailed reset flow arrives in Phase 2).

## 6. Permissions (Phase 0 matrix)

Workspace roles: `admin`, `member`. Project roles: `manager`, `editor`, `commenter`, `viewer`. Admins implicitly hold `manager` on every project. Non-restricted projects are listable by any workspace user (implicit `viewer`); restricted projects are visible to members only.

| Action | admin | member+manager | member+editor | member+commenter/viewer | member, no grant |
|---|---|---|---|---|---|
| List/read project | yes | yes | yes | yes | non-restricted only |
| Create project | yes | yes (any member) | - | - | yes |
| Rename/archive project, palette | yes | yes | no | no | no |
| Manage project members | yes | yes | no | no | no |
| Create/rename/move/delete folders | yes | yes | yes | no | no |
| Workspace settings, users, invites | yes | no | no | no | no |
| Audit log read | yes | no | no | no | no |

Enforcement is a single `requireProjectRole(minRole)` middleware plus `requireAdmin`; the matrix above is encoded as a table-driven unit test (every cell asserted through real HTTP calls).

## 7. API contract

All routes under `/api/v1`. Auth = session cookie or bearer token unless marked public. Bodies validated with zod; responses documented via `@hono/zod-openapi`; `GET /api/v1/openapi.json` serves the spec and `GET /api/docs` a reference UI. Wire shapes below show the essential fields; every object includes `id` and timestamps.

Wire objects (hashes and secrets are never serialized):
- User: `{id, email, name, role, disabled_at, created_at}`
- Project: `{id, name, status, palette, restricted, created_by, created_at, updated_at, my_role}`
- Folder: `{id, project_id, parent_id, name, created_at}`
- Invite: `{id, email, role, project_grants, invited_by, created_at, expires_at}`
- ApiToken: `{id, name, token_prefix, created_at, last_used_at}` (plus `token` only in the POST response)
- MemberEntry: `{user: User, role}`
- AuditEntry: `{id, actor_user_id, action, target, meta, at}`

Palette: enum of the ten library keys `kuwanomi | sakinezu | shinai | yorukou | tetsukon | ebicha | sumimai | yoai | kachitetsu | mokutan` (source of truth: a `PALETTES` const in `packages/core`, hexes matching `mockups/tokens.css`). Default when omitted at create: round-robin, `PALETTES[projectCount % 10]`.

`my_role` serialization: workspace admins always read `manager`; members read their grant; members with no grant on a non-restricted project read `viewer`.

Pagination mechanics: `WHERE id < <decoded cursor>` ordered `id DESC`; an undecodable or malformed cursor is 400 `validation_failed`. Unpaginated by design (plain `{items}`): `/tokens`, `/projects/:id/members`, `/projects/:id/folders`.

| # | Method + path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| 1 | POST `/setup` | public, pre-user only | `{workspace_name, name, email, password}` | 201 `{user, session: set-cookie}` | 404 after first user; 400 |
| 2 | POST `/auth/login` | public | `{email, password}` | 200 `{user}` + cookie | 401 `invalid_credentials`; 429 |
| 3 | POST `/auth/logout` | session | - | 204 | - |
| 4 | GET `/auth/session` | any | - | 200 `{user, auth: 'session'|'token'}` | 401 |
| 5 | GET `/auth/oidc/start` | public | - | 302 | 404 if OIDC unconfigured |
| 6 | GET `/auth/oidc/callback` | public | provider params | 302 `/` + cookie | 403; 429 |
| 7 | GET `/workspace` | any | - | 200 `{id, name, settings, oidc_enabled}` | - |
| 8 | PATCH `/workspace` | admin | `{name?, settings?}` (settings must be `{}` this phase; 400 otherwise) | 200 workspace | 400 |
| 9 | GET `/users` | admin | pagination | `{items: [user], next_cursor}` | - |
| 10 | GET `/users/me` | any | - | 200 user | - |
| 11 | PATCH `/users/me` | any | `{name?, password?: {current, new}}` | 200 user | 401 on bad current |
| 12 | PATCH `/users/:id` | admin | `{role?, disabled?}` | 200 user | 409 demoting or disabling last admin |
| 13 | DELETE `/users/:id` | admin | - | 204 | 409 deleting last admin/self, or a user referenced by `projects.created_by`/`invites.invited_by` (message: disable instead) |
| 14 | POST `/invites` | admin | `{email, role, project_grants?}` (grants validated: project exists, role enum) | 201 `{invite, accept_url}` | 409 existing user/invite |
| 15 | GET `/invites` | admin | pagination | `{items: [Invite], next_cursor}` (pending only) | - |
| 16 | DELETE `/invites/:id` | admin | - | 204 | - |
| 17 | POST `/invites/lookup` | public | `{token}` (POST so tokens stay out of URLs/logs) | 200 `{email, workspace_name}` | 404 expired/used; 429 |
| 18 | POST `/invites/accept` | public | `{token, name, password}` | 201 `{user}` + cookie | 404; 409 `conflict` if the email gained an account since the invite; 429 |
| 19 | GET `/tokens` | session | - | `{items: [{id,name,token_prefix,last_used_at}]}` | - |
| 20 | POST `/tokens` | session | `{name}` | 201 `{token: 'olt_...', ...}` once | - |
| 21 | DELETE `/tokens/:id` | session | - | 204 | - |
| 22 | GET `/projects` | any | pagination, `?status=` (default `active`) | projects visible to caller, `my_role` included | - |
| 23 | POST `/projects` | any | `{name, palette?, restricted?}` (palette enum; default round-robin) | 201 project (creator becomes manager) | 400 |
| 24 | GET `/projects/:id` | project viewer | - | 200 project | 404 |
| 25 | PATCH `/projects/:id` | manager | `{name?, palette?, restricted?, status?}` | 200 project | 403/404 |
| 26 | DELETE `/projects/:id` | admin | - | 204 (hard delete; archives are the soft path) | - |
| 27 | GET `/projects/:id/members` | project viewer | - | `{items: [MemberEntry]}` | - |
| 28 | PUT `/projects/:id/members/:userId` | manager | `{role}` | 200 MemberEntry | 409 demoting last manager |
| 29 | DELETE `/projects/:id/members/:userId` | manager | - | 204 | 409 last manager |
| 30 | GET `/projects/:id/folders` | project viewer | `?parent_id=` | direct children, name ASC | - |
| 31 | POST `/projects/:id/folders` | editor | `{name, parent_id?}` | 201 folder | 409 sibling name; 400 depth > 10 |
| 32 | PATCH `/folders/:id` | editor | `{name?, parent_id?}` (move/rename; parent must be in the same project) | 200 folder | 409; 400 cycle, depth, or cross-project parent |
| 33 | DELETE `/folders/:id` | editor | - | 204 (subtree) | - |
| 34 | GET `/audit` | admin | pagination, `?action=` | `{items: [AuditEntry], next_cursor}` | - |
| 35 | GET `/healthz` | public | - | 200 `{status:'ok', version}` (version = package.json version + short git SHA baked at build) | - |

Audit actions written in this phase: `user.login`, `user.login_failed`, `user.logout`, `oidc.login`, `setup.complete`, `user.create|update|disable|delete`, `invite.create|accept|revoke`, `token.create|revoke`, `project.create|update|archive|delete`, `project.member_set|member_remove`, `folder.create|rename|move|delete`, `workspace.update`.

## 8. Web SPA shell

SvelteKit adapter-static, SPA fallback, served by the API server at `/` (and Workers Assets on CF). Design tokens ported from `mockups/tokens.css` into `packages/web/src/lib/tokens.css` verbatim (single source; mockups become dead reference once this lands).

Pages this phase:
- `/login`: per mockup (Kuwanomi field, dark panel, SSO button shown only when `oidc_enabled`).
- `/setup`: first-run form, same visual register as login.
- `/invite/[token]`: lookup, name+password form, lands in the app.
- `/` projects wall: per mockup including featured card, breathing gradients (CSS from mockup). The needs-attention and activity rails render their intentional empty states from hardcoded empty data this phase (single quiet line each); their endpoints arrive in Phase 2. No stub endpoints.
- `/projects/[id]`: placeholder interior (header tinted with the project palette, folder tree CRUD UI: create, rename inline, move via drag, delete with confirm).
- `/settings`, `/settings/members` (admin: users, invites with copyable accept link, roles), `/settings/tokens`.

Client: generated types from the OpenAPI doc (`openapi-typescript`), thin `fetch` wrapper handling the error envelope and 401 redirect. Auth state in a Svelte 5 rune store hydrated from `GET /auth/session`.

Dev topology: Vite dev server proxies `/api` to the Node dev server so browser requests are always same-origin; the API never sends CORS headers, in dev or prod (cross-origin API consumers use bearer tokens, which skip the origin check). JSON request bodies are capped at 1 MB (413 via `validation_failed`).

Keyboard-first from day one: palette-less command surface deferred, but every interactive element reachable by Tab order, folder rename on F2/double-click, Escape/Enter semantics in all dialogs, and visible focus outlines (accent color, 1px).

## 9. apps/server and deployment

- `apps/server`: builds `packages/web`, serves static output + API from one Hono/Node process; `migrate()` then listen. Graceful shutdown on SIGTERM.
- Dockerfile: multi-stage (pnpm build, distroless-ish node runtime), image `onelight`, volume `/data`.
- `deploy/docker-compose.yml`: the app container + `/data` volume; `Caddyfile.example` for TLS; document Cloudflare Tunnel alternative in README.
- Seed: `pnpm seed` (and `docker compose exec onelight node seed.js`) creates demo workspace, admin `demo@onelight.local` / printed password, 6 projects with palettes matching the mockups, folder trees. Idempotent.

## 10. apps/cf

Workers entry building the same Hono app with D1 + PBKDF2 hasher + Workers Assets. `wrangler.jsonc` declares D1 binding and assets; D1 migrations from the shared `packages/db/migrations`. No queue/container/DO this phase. CI runs the contract suite under `@cloudflare/vitest-pool-workers`; a manual `wrangler deploy` smoke is documented but not automated.

## 11. Task list (dependency order)

Each task lands as one PR-sized change with its acceptance checks green. AC = acceptance check.

| ID | Task | AC |
|---|---|---|
| T01 | Repo scaffold: workspaces, tsconfig.base, eslint/prettier, LICENSE, README, CI skeleton (lint+typecheck) | `pnpm lint && pnpm typecheck` green on empty packages |
| T02 | `packages/core`: ULID gen, clock, error types, config loader, ports file | unit tests: ULID monotonic, config zod rejects missing SECRET_KEY |
| T03 | `packages/db`: full §4 schema in Drizzle, generated migration (hand-edited where §4 requires, e.g. the expression index), node migrate runner with `foreign_keys=ON` | migration applies to a fresh file DB; DDL diff test vs §4 passes; FK enforcement asserted |
| T04 | `packages/api` skeleton: Hono app factory taking `AppEnv`, error envelope middleware, request-id + logging, `/healthz` | contract test boots app in-memory and asserts envelope shape on a thrown route |
| T05 | PasswordHasher: PBKDF2-100k (shared, WebCrypto) + argon2id (node-only) per §5 | PBKDF2 hash created on Node verifies on the workers pool and vice versa; argon2 create+verify covered on the Node leg; Workers `verify` of an argon2 hash returns false without throwing |
| T06 | Sessions + cookie middleware + origin-check middleware | tests: cookie flags, sliding expiry, origin rejection on mutation, bearer exemption |
| T07 | `/setup` + headless first-run | boots empty, setup once, 404 after; env-var path covered |
| T08 | `/auth/login`, `/auth/logout`, `/auth/session` + rate limiting | matrix test incl. 429 with Retry-After; audit rows written |
| T09 | Users endpoints (`/users*`, me, role changes, last-admin guards) | last-admin demote/delete return 409; disabled user's sessions rejected |
| T10 | Invites end-to-end (create, lookup, accept, revoke) incl. project_grants | accepted invite creates user with grants applied; expired token 404 |
| T11 | API tokens + bearer middleware | token shown once; hash-only storage asserted; bearer request passes origin-check exemption |
| T12 | OIDC start/callback with jose, identity linking, auto-provision rules | tests against a mock issuer (local JWKS): happy path, bad nonce, domain rejection, linking |
| T13 | Workspace GET/PATCH | admin-only PATCH asserted |
| T14 | Projects CRUD + archive + palette + restricted | visibility rules tested (restricted invisible to non-members) |
| T15 | Project members + `requireProjectRole` + full §6 matrix test | every matrix cell asserted via HTTP |
| T16 | Folders CRUD: sibling uniqueness, depth cap, move-cycle rejection, same-project rule, subtree delete | property test: random move sequences never produce cycle, depth > 10, or cross-project parent |
| T17 | Audit log writes on all §7 actions + `/audit` | each action asserted to write exactly one row |
| T18 | OpenAPI generation, `/api/docs`, generated TS client into web | spec validates; client typechecks against a compiled route sample |
| T19 | `packages/web` scaffold: tokens.css port, API client, auth store, login/setup/invite pages | manual: login and setup flows work against dev server; no border rule violations |
| T20 | Projects wall + project interior (folder CRUD UI) + settings/members/tokens pages | manual walkthrough of milestone script; empty states intentional |
| T21 | `apps/server` + Dockerfile + compose + Caddyfile + seed + `reset-password` CLI | `docker compose up` from clean checkout reaches login (default PUBLIC_URL); seed idempotent (run twice); reset-password prints a working one-time password and revokes sessions |
| T22 | `apps/cf` entry + D1 migrations + vitest-pool-workers CI job | full contract suite green on workers pool |
| T23 | CI complete: lint, typecheck, unit+contract (node), contract (workers), docker build | all jobs green on main |

## 12. Definition of done

The design doc Phase 0 milestone verbatim, plus:
- Contract suite (every §7 endpoint, every §6 matrix cell) green on better-sqlite3 and on D1/workers pool.
- OpenAPI doc published and the web client generated from it.
- Fresh-clone experience: `docker compose up`, browse to PUBLIC_URL, complete setup, create project, invite member via copyable link, second browser accepts and sees the project. Under 10 minutes, documented in README.
- No emojis, no em dashes, no borders outside the sanctioned list, in any shipped surface.
