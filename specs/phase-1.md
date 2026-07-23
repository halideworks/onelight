# Onelight Phase 1 Implementation Spec

Ingest and pipeline: blob storage, resumable uploads, media probing, proxy generation, sidecars, and the job worker.

This spec supersedes the Phase 1 milestone text in `onelight_design_doc.md` only where it supplies concrete schemas, routes, and task order. The design document remains authoritative for product behavior, media recipes, color handling, and licensing posture.

## 0. Scope

Phase 1 adds uploads and media processing. It does not add comments, shares, realtime review, NLE exports, or the full player surface.

The Linux Docker worker is the reference implementation. Windows development may use a local ffmpeg installation, but the worker contract and image must remain Linux-first.

## 1. Ports and adapters

`packages/core/src/ports.ts` defines:

```ts
interface BlobStore {
  putStream(key: string, stream: ReadableStream, meta: { contentType?: string; size?: number }): Promise<void>
  createMultipart(key: string, meta: { contentType?: string; size?: number }): Promise<{ uploadId: string; partSize: number }>
  signPartUrl(key: string, uploadId: string, partNo: number): Promise<string>
  completeMultipart(key: string, uploadId: string, parts: Array<{ partNo: number; etag: string }>): Promise<void>
  listParts(key: string, uploadId: string): Promise<Array<{ partNo: number; etag: string; size: number }>>
  signGetUrl(key: string, options: { expires: number; contentDisposition?: string }): Promise<string>
  getStream(key: string, range?: { start: number; end?: number }): Promise<ReadableStream>
  delete(key: string): Promise<void>
}

interface Transcoder {
  probe(source: { key: string }): Promise<MediaInfo>
  run(job: TranscodeJob): Promise<TranscodeResult>
}

interface JobQueue {
  enqueue(job: JobSpec): Promise<string>
}
```

Node uses local disk storage and a signed local upload URL. The S3 adapter uses AWS-compatible multipart calls and works with MinIO, S3, B2, and R2. The worker invokes `ffprobe`, `ffmpeg`, `audiowaveform`, `pdftoppm`, and `libvips` as separate processes.

## 2. Database delta

The Phase 0 DDL remains exact. Phase 1 tables that do not carry a direct `workspace_id` derive scope transitively: assets through projects, versions through assets, renditions through versions, and jobs through the workspace ID in their validated payload. Every route query must join through that ownership path, and the contract suite includes cross-workspace leakage tests.

All new tables use ULID text keys and epoch milliseconds. These statements append to the Phase 0 schema.

```sql
ALTER TABLE projects ADD COLUMN storage_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  client_filename TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum_crc32c TEXT,
  blob_key TEXT NOT NULL,
  upload_id TEXT,
  part_size INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','uploading','completed','quarantined','aborted')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX upload_sessions_project_idx ON upload_sessions(project_id, status);

CREATE TABLE upload_parts (
  upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_no INTEGER NOT NULL,
  etag TEXT,
  size INTEGER,
  completed_at INTEGER,
  PRIMARY KEY (upload_id, part_no)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video','audio','image','pdf','file')),
  current_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none','in_review','approved','changes_requested')),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX assets_project_idx ON assets(project_id, deleted_at, id);

CREATE TABLE asset_versions (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  upload_session_id TEXT NOT NULL UNIQUE REFERENCES upload_sessions(id),
  version_no INTEGER NOT NULL,
  original_blob_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  checksum_crc32c TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  media_info_json TEXT NOT NULL DEFAULT '{}',
  source_timecode_start TEXT,
  source_start_frame INTEGER,
  frame_rate_num INTEGER,
  frame_rate_den INTEGER,
  drop_frame INTEGER,
  duration_frames INTEGER,
  color_json TEXT NOT NULL DEFAULT '{}',
  transcode_status TEXT NOT NULL DEFAULT 'pending' CHECK (transcode_status IN ('pending','processing','ready','failed','skipped')),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(asset_id, version_no)
);
CREATE INDEX asset_versions_asset_idx ON asset_versions(asset_id, version_no);

CREATE TABLE renditions (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('proxy_2160','proxy_1080','proxy_540','hdr_hevc','hdr_av1','audio_peaks','sprite','poster','pdf_pages','still_tiles','watermarked')),
  blob_key TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  size INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT NOT NULL DEFAULT '',
  share_id TEXT,
  created_at INTEGER NOT NULL,
);
CREATE UNIQUE INDEX renditions_base_uq ON renditions(version_id, kind) WHERE share_id IS NULL;
CREATE UNIQUE INDEX renditions_share_uq ON renditions(version_id, kind, share_id) WHERE share_id IS NOT NULL;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','complete','failed','dead')),
  priority INTEGER NOT NULL DEFAULT 0,
  capability_json TEXT NOT NULL DEFAULT '{}',
  max_attempts INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  heartbeat_at INTEGER,
  lease_expires_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  worker_id TEXT
);
CREATE INDEX jobs_claim_idx ON jobs(status, run_after);

CREATE TABLE project_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX project_events_replay_idx ON project_events(project_id, id);
```

## 3. API contract

All routes use `/api/v1`, the Phase 0 error envelope, and bearer or session authentication.

| Method and path | Request | Response |
|---|---|---|
| POST `/uploads` | `{project_id, filename, relative_path, size, checksum_crc32c}` | `201 {upload, upload_url}` |
| POST `/uploads/:id/multipart` | `{}` | `200 {upload_id, part_size}` |
| GET `/uploads/:id/parts` | none | `{items}` |
| GET `/uploads/:id/parts/:partNo/url` | none | `{url}` |
| PUT `/uploads/:id/parts/:partNo` | raw part body | `204` |
| POST `/uploads/:id/complete` | `{parts, checksum_crc32c}` | `202 {upload, job_id}` |
| DELETE `/uploads/:id` | none | `204` |
| POST `/uploads/:id/abort` | none | `204` |
| GET `/projects/:id/assets` | pagination and `folder_id` | `{items, next_cursor}` |
| POST `/projects/:id/assets` | `{name, folder_id?, upload_id}` | `201 asset` |
| GET `/assets/:id` | none | `asset` |
| PATCH `/assets/:id` | `{name?, folder_id?, status?}` | `asset` |
| DELETE `/assets/:id` | none | `204` |
| GET `/versions/:id` | none | `version` |
| GET `/versions/:id/renditions` | none | `{items}` |
| GET `/jobs/:id` | none | `job` |
| GET `/projects/:id/events` | `Last-Event-ID` | SSE events |
| GET `/admin/jobs` | pagination and status | `{items, next_cursor}` |

Upload URLs are short-lived and scoped to one upload session. All blob reads use signed URLs. A completed upload cannot be associated with a second asset because `asset_versions.upload_session_id` is unique. Mutating upload requests accept an `Idempotency-Key`; retries return the original result.

Supersession (2026-07-11 audit): `POST /uploads/:id/complete` returns `202 {upload}` without a `job_id`. The probe job is created when the upload is attached to an asset, because the probe payload carries `asset_id` and `version_id`, which do not exist until `POST /projects/:id/assets`. That endpoint returns the `job_id`. Clients poll `GET /jobs/:id` from there.

Supersession (2026-07-11, Idempotency-Key scope): the header is honored through natural idempotency rather than a key-to-response replay store, which would need schema the phase does not own. `POST /uploads` with an `Idempotency-Key` that matches an existing pending or uploading session created by the same user for the same project, filename, and size returns that original session with `200` instead of opening a duplicate. `POST /uploads/:id/complete` is already idempotent: re-completing a completed session returns `202` with the original result, so the header needs no bookkeeping there. A general response-replay store keyed on the header value is future work.

## 4. Job behavior

`complete upload -> probe -> plan -> sidecars and proxies` is idempotent. The primary 1080p proxy makes a version ready. Failure of a secondary rendition does not hide the primary proxy, and each rendition can be retried independently. Job claims use one conditional update: queued jobs whose lease expired are reclaimable, `heartbeat_at` extends `lease_expires_at`, and `max_attempts` moves a job to `dead`.

The probe stores the complete ffprobe JSON plus normalized fields. VFR is detected by comparing rational rates and `vfrdet`. CFR output uses the source `avg_frame_rate` when it is a supported rational rate, otherwise the nearest supported rate recorded in the version metadata. SDR proxies use the exact Phase 0 recipe: progressive faststart MP4, `fps=num/den`, 1-second GOP, explicit BT.709/tv tags, AAC stereo, and preserved tmcd. HDR sources receive AV1 10-bit first, HEVC Main10 `hvc1` when Safari support is enabled, source primaries and transfer, `mdcv` and `clli` when present, plus a libplacebo BT.2390 SDR proxy. HLG inverse OOTF handling is explicit in the worker command. Each recipe has a golden ffprobe assertion.

## 5. Task order and gates

| ID | Task | Acceptance |
|---|---|---|
| P1-T01 | Add ports, storage configuration, and Phase 1 migration | Migration applies on Node and D1. Schema drift test remains green. |
| P1-T02 | Implement local BlobStore and signed local part URLs | Part upload, range read, delete, and path traversal rejection are tested. |
| P1-T03 | Implement S3 multipart adapter | Uniform part sizes, resume listing, completion, and abort are contract-tested against a local S3-compatible fixture. |
| P1-T04 | Add upload routes and CRC32C validation | A killed upload resumes from listed parts and checksum mismatch quarantines the upload. |
| P1-T05 | Add jobs table, atomic lease claim, heartbeat, retry, capability matching, and dead-letter logic | Duplicate idempotency keys produce one job. A killed worker retries without duplicate renditions. Lease expiry and max attempts are tested. |
| P1-T06 | Implement ffprobe probe and normalized media info | Fixture corpus records rational rate, VFR, color, audio, duration, and tmcd correctly. |
| P1-T07 | Implement Linux worker image, signed job protocol, and proxy recipes | Worker image runs as a non-root user, exposes health and signed `POST /jobs`, reads source by HTTP range, uploads by multipart, and emits tagged CFR proxies with the required ladder. No source is staged beyond the 20 GB disk budget. |
| P1-T08 | Add posters, sprites, VTT, peaks, PDF pages, and still previews | Sidecars are reachable by signed URLs and do not block primary proxy readiness. |
| P1-T09 | Add assets, versions, rendition routes, SSE progress, and trash | Asset and version lifecycle is idempotent and tested through HTTP. |
| P1-T10 | Add upload UI and admin queue UI | Resume, progress, retry, and quarantine states are visible. |
| P1-T11 | Add project SSE replay and run Node and Workers contract suites | Event IDs replay from the persistent project event window. Both suites pass. Linux Docker build and worker smoke pass. |

## 6. Required manual checks

David will manually test the 23.976 ProRes tmcd path, HDR behavior, and browser color matrix. The automated suite must still retain fixtures and assertions for those cases.

Supersession (2026-07-23): probing preserves the exact reduced
`avg_frame_rate` rational, using `r_frame_rate` only as a fallback, and never
clamps to a nearby editorial rate. A dedicated `tmcd` stream wins over format
and other stream tags; the selected tag source is retained. Source color
metadata now includes primaries, transfer, matrix, range, chroma location,
pixel format, bit depth, field order, and side data in addition to the complete
ffprobe JSON.

SDR proxy conversion explicitly resolves source matrix, transfer, primaries,
and range before producing BT.709 limited range. Untagged SD is interpreted as
BT.601, untagged HD as BT.709, and full-range sources are numerically converted
to limited range rather than relabeled. Proxies and burned-watermark
derivatives re-embed the selected source timecode, and the integration test
probes their timecode track and color tags.
