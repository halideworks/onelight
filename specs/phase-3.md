# Onelight Phase 3 Implementation Spec

Sharing, presentation pages, watermarks, webhooks, reports, and v1 NLE exports.

This is the v1 release phase. It depends on Phases 0 through 2 and must retain the public REST and OpenAPI contract.

## 1. Database delta

Shares derive workspace through projects. Viewer sessions are signed, share-scoped cookies whose claims contain share ID, viewer key, issued time, and expiry. The database stores the viewer key, never a bearer token.

```sql
CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('review','presentation')),
  title TEXT NOT NULL,
  layout TEXT NOT NULL CHECK (layout IN ('grid','list','reel')),
  passphrase_hash TEXT,
  expires_at INTEGER,
  allow_download TEXT NOT NULL CHECK (allow_download IN ('none','proxy','original')),
  allow_comments INTEGER NOT NULL DEFAULT 1,
  show_all_versions INTEGER NOT NULL DEFAULT 0,
  watermark_spec_json TEXT,
  watermark_spec_hash TEXT,
  brand_json TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE share_assets (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(share_id, asset_id)
);

CREATE TABLE share_viewers (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  viewer_key TEXT NOT NULL,
  name TEXT,
  email TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  view_state_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(share_id, viewer_key)
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','delivering','delivered','failed','dead')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE(webhook_id, event_id)
);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('resolve_edl','avid_txt','avid_xml','xmeml','fcpxml','csv','json','text','pdf')),
  filters_json TEXT NOT NULL DEFAULT '{}',
  timecode_base TEXT NOT NULL CHECK (timecode_base IN ('source','record_run')),
  status TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed')),
  result_blob_key TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
```

## 2. API contract

| Method and path | Request | Response |
|---|---|---|
| POST `/shares` | share settings and asset IDs | `201 share` |
| GET `/shares` | project and pagination filters | `{items, next_cursor}` |
| GET `/shares/:id` | none | share |
| PATCH `/shares/:id` | editable settings | share |
| DELETE `/shares/:id` | none | `204` |
| GET `/s/:slug` | optional passphrase cookie | presentation shell |
| POST `/s/:slug/access` | `{passphrase?, name?, email?}` | viewer session and share |
| GET `/s/:slug/assets` | viewer session | public asset projection |
| GET `/s/:slug/assets/:assetId` | viewer session | asset versions and rendition metadata |
| GET `/s/:slug/assets/:assetId/comments` | viewer session | public comments |
| GET `/s/:slug/assets/:assetId/media` | viewer session | signed rendition URL |
| POST `/s/:slug/assets/:assetId/comments` | anonymous comment shape | `201 comment` |
| PATCH `/s/:slug/comments/:commentId` | viewer session and ownership | `comment` |
| DELETE `/s/:slug/comments/:commentId` | viewer session and ownership | `204` |
| POST `/s/:slug/comments/:commentId/replies` | viewer session | `201 comment` |
| PATCH `/s/:slug/approval` | `{asset_id, status}` | approval state |
| POST `/shares/:id/export` | `{format, filters, timecode_base}` | `202 export job` |
| GET `/exports/:id` | authenticated project member | export job |
| GET `/exports/:id/download` | authenticated project member | signed export URL |
| POST `/webhooks` | `{url, secret?, events}` | `201 webhook` |
| GET `/webhooks` | none | `{items}` |
| DELETE `/webhooks/:id` | none | `204` |

Share access is password and expiry checked before viewer state is issued. Viewer sessions use an HMAC-signed cookie with a 24-hour expiry and a fresh signature on access. Viewer media URLs are share-scoped, signed for 15 minutes, and cease to be issued immediately after revoke. Existing URLs expire naturally within that TTL. Cookie mutations require the share origin, and passphrase and anonymous comment attempts are rate-limited per share and IP.

## 3. Export formats

`packages/core/src/markers` provides deterministic serializers for Resolve marker EDL with preserved text, Avid marker text, Premiere xmeml, FCPXML rational marker times, CSV, JSON, and plain text. Same-frame collisions are grouped into one Resolve marker with a stable `\n`-joined body ordered by comment ULID, because Resolve collapses same-frame markers. Range comments become duration markers. Resolve labels are sanitized to avoid leading digits and unsupported characters.

PDF reports use the worker burn-in renderer and include the annotated frame, source timecode, author, body, and thread state. Export filters are serialized with the export job for auditability.

Supersession (2026-07-11 audit): the `avid_xml` format currently emits the same Media Composer five-field tab-separated marker text as `avid_txt`. No verified MC marker XML schema exists in docs/research, and the design doc requires round-tripping a real MC export before shipping a bespoke XML shape. Replace with true MC XML once a captured reference export is available.

Supersession (2026-07-23 NLE quality pass): marker notes retain author,
completed state, internal state on project exports, and thread replies. Share
exports are server-constrained to share assets and exclude internal comments.
Each version is serialized with its own exact rate, timecode origin, duration,
and drop-frame state. xmeml marker positions are sequence-relative and its
timecode element carries the source origin. FCPXML uses exact rational time,
source `tcStart`, and media duration. Multi-version exports contain one valid
file per version in a ZIP instead of concatenating complete documents.
Resolve and Premiere imports were manually validated on 2026-07-23. Media
Composer and Final Cut remain pending real-application validation.

## 4. Watermarking and webhooks

Burned watermarks are cached per share and invalidated when the watermark spec changes or the share is revoked. Session overlays are explicitly deterrent-grade and may be removed with browser tools. Webhooks use HMAC-SHA256, include an idempotency event ID, retry with exponential backoff, and never block the request that created the event.

## 5. Task order and gates

| ID | Task | Acceptance |
|---|---|---|
| P3-T01 | Add shares, viewers, webhooks, and migrations | Node and D1 schema drift tests pass. |
| P3-T02 | Implement share access and viewer cookie | Passphrase attempts and anonymous comments are rate-limited per share and IP. |
| P3-T03 | Implement signed share media access and public projections | Revoked shares stop issuing URLs and issued URLs expire within 15 minutes. Viewer ownership is checked on comment mutations. |
| P3-T04 | Implement presentation layouts and OG metadata | Grid, list, and reel pages render from the share model. |
| P3-T05 | Implement burned and session watermark paths | Per-share cache keys include the full watermark specification and source version. |
| P3-T06 | Implement marker serializers and golden files | Text, frame positions, duration, and timecode base match fixtures. |
| P3-T07 | Implement PDF report export | Rendered report includes annotated stills and thread text. |
| P3-T08 | Implement persistent webhook delivery and audit events | HMAC verification, retry after restart, delivery idempotency, and payload schema tests pass. |
| P3-T09 | Harden routes and deploy docs | Signed media reads, revocation, download controls, and backup guidance are documented. |
| P3-T10 | Release v1 verification | Automated gates, Linux browser screenshots, accessibility checks, and visual review against the mockups pass. David manually validates real NLE imports and browser color behavior. |
