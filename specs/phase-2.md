# Onelight Phase 2 Implementation Spec

Player, comments, versions, approvals, notifications, and the review-room interaction model.

This spec depends on Phase 1 assets, versions, renditions, jobs, and signed media URLs. It does not add shares or NLE export formats beyond the serializer test fixtures required for the player comment model.

## 1. Database delta

Phase 2 keeps the Phase 0 tenancy decision. Comments derive workspace through asset versions and projects. Anonymous comment ownership is stored as a signed viewer key string until Phase 3 introduces the share viewer table.

```sql
ALTER TABLE assets ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id),
  author_name TEXT,
  author_email TEXT,
  viewer_key TEXT,
  frame_in INTEGER,
  frame_out INTEGER,
  body_text TEXT NOT NULL,
  annotation_json TEXT,
  pin_xy_json TEXT,
  page_no INTEGER,
  internal INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  completed_by TEXT REFERENCES users(id),
  carried_from_comment_id TEXT REFERENCES comments(id),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX comments_version_frame_idx ON comments(version_id, deleted_at, frame_in, id);

CREATE TABLE comment_attachments (
  id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  blob_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE comment_reads (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY(comment_id, user_id)
);

CREATE TABLE comment_reactions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY(comment_id, user_id, emoji)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at, id);

CREATE VIRTUAL TABLE comment_search USING fts5(comment_id UNINDEXED, body_text, hashtags);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'instant' CHECK (mode IN ('instant','hourly','daily')),
  muted_projects_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
```

Supersession note (2026-07-11): the `comment_search` FTS5 virtual table above is not created. Migrations must apply identically on better-sqlite3 and D1, and the Cloudflare research report does not establish that D1 supports FTS5 virtual tables. v1 ships `GET /search` as LIKE-based matching over asset names and comment bodies; the FTS table is deferred until D1 support for FTS5 is verified.

## 2. API contract

| Method and path | Request | Response |
|---|---|---|
| GET `/versions/:id/comments` | filters, sort, pagination | `{items, next_cursor}` |
| POST `/versions/:id/comments` | `{frame_in?, frame_out?, body_text, annotation?, pin_xy?, internal?}` | `201 comment` |
| PATCH `/comments/:id` | editable body and anchors | `comment` |
| DELETE `/comments/:id` | none | `204` |
| POST `/comments/:id/replies` | `{body_text, annotation?}` | `201 comment` |
| POST `/comments/:id/complete` | none | `comment` |
| POST `/comments/:id/reactions` | `{code}` | `204` |
| DELETE `/comments/:id/reactions/:code` | none | `204` |
| POST `/comments/:id/attachments` | multipart file | `201 attachment` |
| GET `/comments/:id/attachments/:attachmentId` | none | signed URL |
| DELETE `/comments/:id/attachments/:attachmentId` | none | `204` |
| POST `/versions/:id/carry-forward` | `{from_version_id}` | `{items}` |
| GET `/assets/:id/versions` | none | `{items}` |
| POST `/assets/:id/versions` | `{upload_id, name?, carry_forward?}` | `201 {asset, version, job_id}` |
| PATCH `/versions/:id/stack` | `{version_no}` | `{items}` |
| POST `/assets/:id/trash` | none | `204` |
| POST `/assets/:id/restore` | none | `asset` |
| PATCH `/assets/:id/approval` | `{status}` | `asset` |
| GET `/projects/:id/events` | `Last-Event-ID` | SSE events |
| GET `/notifications` | pagination | `{items, next_cursor}` |
| POST `/notifications/read` | `{ids}` | `204` |
| GET `/sessions` | none | `{items}` |
| DELETE `/sessions/:id` | none | `204` |
| GET `/search` | `q`, scope, pagination | `{items, next_cursor}` |

Share-scoped requests never include `internal=true` comments. Author identity is either a user or a named share viewer supplied by Phase 3. One-level replies are allowed. Frame anchors must be nonnegative, `frame_out` must be greater than or equal to `frame_in`, and annotation JSON is capped at 256 KiB. A comment author can edit or delete their own comment, while managers can moderate project comments. Archived projects are read-only. Reaction values are named codes such as `thumbs_up` and `heart`; the UI and source contain no emoji glyphs. Frame anchors use integers and the version rational rate, never seconds.

Supersession (2026-07-11 audit): the reactions table column is `code` (named reaction codes), not `emoji`, consistent with the no-emoji rule; the section 1 DDL's `emoji` column name is superseded. `comment_reactions` carries `created_at` and `comment_attachments` carries `content_type` and `checksum_sha256`; these columns are additive and are part of the shipped schema.

Supersession (2026-07-11, version stacking and mentions): `POST /assets/:id/versions` joins the contract (row above). Project editor; the upload must be completed, belong to the asset's project, and be unattached (409 otherwise). The new version takes `version_no = max + 1`, becomes the asset's current version, enqueues a probe job exactly like the initial attach (idempotency `probe:<version_id>`), updates storage accounting, and emits the `asset.version_created` project event. `carry_forward: true` copies unresolved comments from the previous current version with `carried_from_comment_id` provenance, and an optional `name` renames the asset. Notification kind `version.created` goes to prior-version uploaders and project managers, never the actor. `POST /versions/:id/comments` and `POST /comments/:id/replies` gain an optional `mentions: string[]` field (user ids, max 20, authed routes only): ids that cannot see the project are dropped silently, and mentioned users receive kind `comment.mention`, which supersedes the `comment.created` or `comment.reply` row for the same comment. Comment wire objects carry a derived `tags` array (hashtags `#[a-z0-9_]+` extracted from `body_text`; no column), and a `GET /search` query starting with `#` performs whole-token hashtag matching over comment bodies. Comment create, update, and delete (member and share-viewer paths alike) now append `comment.created`, `comment.updated`, and `comment.deleted` project events with id-sized payloads. Password reset ships in this phase's scope: migration `0005_password_resets.sql` (password_resets table plus `notifications.emailed_at`), an optional `Mailer` port on AppEnv, `POST /auth/reset-request` (always 204, rate limited per email and IP, one-hour single-use token, audit row when no mailer is configured), and `POST /auth/reset` (validates the token, applies the password policy, revokes every session). `GET /shares/:id/viewers` exposes the share viewer roster to the share owner or a project manager, never the viewer key.

## 3. Player contract

`packages/player` owns the video element, rVFC frame clock, verified stepping, J/K/L transport, I/O range state, timeline markers, normalized annotation geometry, and rendition refresh. It exposes Svelte components and a small event interface. `currentTime` never determines frame identity. Frame display uses `Math.round(mediaTime * num / den)` and stepping seeks to frame middle before rVFC verification.

The fallback `<video>` path must work without WebCodecs. The WebCodecs path is feature-gated and covered by a ground-truth harness. Review-room chrome uses only neutral values and contains no gradients or tinted chrome.

## 4. Task order and gates

| ID | Task | Acceptance |
|---|---|---|
| P2-T01 | Add comments, notifications, and search indexes | Migration is green on Node and D1. Internal comments are query-scoped out of share projections. |
| P2-T02 | Implement comment and thread routes | Permission matrix covers every anchor, edit, delete, reply, completion, and reaction path. |
| P2-T03 | Implement SSE hub and event IDs | Reconnect with `Last-Event-ID` does not duplicate or lose events in the Node adapter. |
| P2-T04 | Implement carry-forward and approval state | Unresolved comments copy at the same integer frame with provenance. |
| P2-T04a | Implement version listing, stack mutation, trash restore, and comment validation | Version gaps remain stable, moves are permission-checked, and invalid frame or annotation payloads are rejected. |
| P2-T05 | Implement timecode and marker timeline components | Property tests cover 24 hours at every supported rate and DF rejection rules. |
| P2-T06 | Implement fallback player | rVFC frame clock, verified stepping, J/K/L, I/O, loop, and rendition switching pass browser tests. |
| P2-T07 | Implement annotation overlay | Normalized strokes render in the browser and retain geometry through aspect-ratio changes. |
| P2-T08 | Implement project browser and review room | Keyboard paths, focus outlines, empty states, and neutral review-room tokens match the mockups. |
| P2-T09 | Implement session, notification, and search UI | Unread state, filters, and deep links work through refresh. |
| P2-T10 | Run browser and adapter suites | Node and Workers contract suites pass. Manual browser media checks remain explicit. |
