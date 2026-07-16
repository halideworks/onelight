# Onelight - Design Document & Build Plan

**Self-hosted, open-source media review & approval for post-production professionals.**

A frame.io replacement you own: upload originals, get frame-accurate review proxies, collect timecoded comments and drawings from clients who never need accounts, round-trip everything into your NLE as markers, and share it all through password-protected, watermarked links - on your own hardware, or one-click-deployed to Cloudflare Workers + R2.

Part of the halideworks family (Chromatic handles *live* review sessions; Onelight handles *async* review). AGPL-3.0.

---

## Table of contents

1. [Why this exists](#1-why-this-exists)
2. [Positioning & competitive landscape](#2-positioning--competitive-landscape)
3. [Decisions already made](#3-decisions-already-made)
4. [Architecture](#4-architecture)
5. [Data model](#5-data-model)
6. [Media pipeline](#6-media-pipeline)
7. [Player](#7-player)
8. [Timecode](#8-timecode)
9. [Comments & annotations](#9-comments--annotations)
10. [Versions & comparison](#10-versions--comparison)
11. [Sharing, presentation & watermarking](#11-sharing-presentation--watermarking)
12. [NLE round-trip](#12-nle-round-trip)
13. [Auth, permissions & security](#13-auth-permissions--security)
14. [Uploads](#14-uploads)
15. [Realtime](#15-realtime)
16. [Cloudflare deployment target](#16-cloudflare-deployment-target)
17. [API, CLI & ecosystem](#17-api-cli--ecosystem)
18. [Color-critical mode (the halideworks differentiator)](#18-color-critical-mode)
19. [Licensing & legal landmines](#19-licensing--legal-landmines)
20. [Build plan: phases, milestones, acceptance criteria](#20-build-plan)
21. [Testing strategy](#21-testing-strategy)
22. [Risk register](#22-risk-register)
23. [Open questions](#23-open-questions)
24. [UI design language](#24-ui-design-language)

---

## 1. Why this exists

The async review market is a rent-extraction machine. Frame.io post-Adobe: forced V4 migration broke pipelines, killed the Resolve integration outright, requires Adobe IMS identity, and prices by *seat* when the actual cost driver is storage - a client accidentally invited as a member reprices every seat from $15 to $25/mo. The documented community reaction (r/editors, LiftGammaGain, frame.io's own forums) is an exodus with nowhere good to land: Sony Ci and Kollaborate prove demand for non-seat economics; Dropbox Replay proves demand for cheap NLE breadth; nobody serves "production-grade, self-hosted, NLE-integrated."

The open-source field is effectively empty. Clapshot (253 stars, one Rust dev, SQLite, no approval workflow) is the most mature incumbent. FreeFrame, ViTransfer, shumai, OpenVidReview are all sub-150 stars, young or stalled. **None** have NLE marker round-trip, watermarking, C2C, or a serious permissions model. Demand threads on r/selfhosted go back to 2016.

What practitioners actually ask for, ranked by forum frequency:

1. **Comments -> NLE markers round-trip** (Resolve especially - Adobe vacated it)
2. **No forced client accounts** - reviewers comment with name+email only
3. **Storage-based, not seat-based economics** - self-hosting answers this structurally
4. **Client-proof simplicity** - no proxy-download traps, unambiguous approve
5. **Playback fidelity** - gamma-shift correctness, 10-bit HDR, fast uploads
6. **Watermarking below enterprise pricing**

Onelight's thesis: copy frame.io's comment model (the moat), fix its known failures (Resolve abandonment, EDL-drops-comment-text bug, gamma shifts, comments lost across versions), and delete its business model.

## 2. Positioning & competitive landscape

| Axis | frame.io V4 | Onelight |
|---|---|---|
| Economics | $15-25/seat/mo, storage add-ons, enterprise gates | AGPL, your hardware or your Cloudflare account (~$63-70/mo for 2TB + transcode on CF) |
| Client access | Free reviewers, but watermarking/DRM/secure shares gated to Enterprise Prime | Burned watermarks + passworded/expiring links for everyone |
| Resolve | Abandoned in V4 | First-class target: native plugin + text-preserving marker EDL |
| HDR/color | HDR10 playback on paid plans, known gamma-shift complaints | Color-managed pipeline as a core competency (see §18) |
| Comments across versions | Lost (official answer: copy-paste) | Carried forward + re-anchoring (Phase 7) |
| Hosting | Adobe's cloud only (BYO-S3 at Prime) | Self-hosted Docker, or one-click Cloudflare Workers+R2 |

Feature table stakes inherited from the frame.io V4 spec (research-verified): J/K/L + frame-step player with I/O ranges; timecode/range/pin-anchored comments with drawings, replies, mentions, statuses; version stacks + comparison viewer; shares with passphrase/expiry/download-toggle and anonymous commenting; CSV/PDF/marker exports; originals always downloadable; HMAC-signed webhooks and a stable REST API.

Deliberately deferred or skipped: DRM (Widevine/FairPlay), forensic watermarking (NAGRA-class), semantic search, mobile native apps, 360/VR.

## 3. Decisions already made

Locked with David (2026-07-01):

| Decision | Choice |
|---|---|
| Name | **Onelight** (one-light dailies - the fast review pass) |
| License | **AGPL-3.0** |
| Backend | **TypeScript everywhere**: one Hono codebase, Node/Bun self-hosted, Workers on CF, behind platform ports |
| App shape | **Hono API + SvelteKit static SPA** (Svelte 5, adapter-static) - API is the public contract from day one |
| Media intake | **Full pro intake**: anything ffmpeg decodes (ProRes, DNx, XAVC, H.264/5, stills incl. EXR/DPX singles, audio, PDFs). Image *sequences* and camera raw (BRAW/R3D) deferred (licensing) |
| Tenancy | **Single-org UX, workspace_id in schema from day one** |
| V1 line | Core review loop + NLE marker export + presentation pages + burned-per-link watermarking. Live collab is v2 |
| Auth | **Email/password + OIDC** (Authentik/Keycloak/Google/Entra), passkeys nice-to-have |
| Watermarking | **Burned per-link** at transcode (cached) + client-side session overlay |
| HDR ambition | **Full color-critical mode** (phased: gated HDR rails early; reference mode + scopes later) |
| Scale target | 5-50 users initially, **architected for mid-size facility** (scale-out = config, not rewrite) |
| Serving model | **Hybrid**: public instance is the default; LAN-only instance with a lightweight public edge (Worker/tunnel) proxying review-link traffic is a supported topology |
| NLE priority | **Resolve first**, Premiere UXP panel second; file-based exports in v1 regardless |
| CF one-click | Button provisions everything but the transcoder; documented `wrangler deploy` post-step adds the ffmpeg Container; **Cloudflare Stream as optional managed transcode backend** behind the same port |
| Ecosystem roadmap | NLE integrations, desktop transfer/watch-folder app, C2C-style device ingest - all planned, all post-v1 |

Decisions made in this document (rationale inline): SQLite dialect everywhere (§5), progressive MP4 proxies not HLS (§6), SSE for v1 realtime (§15), pnpm monorepo (§4.4), Drizzle ORM (§5), Uppy uploads (§14).

## 4. Architecture

### 4.1 Topologies

One codebase, three blessed deployments:

**A. Self-hosted (default)** - `docker compose up`:

```
┌─────────────────────────────────────────────────┐
│ onelight (container)                            │
│   Hono API (Node) ── serves SPA + REST + SSE    │
│   SQLite (WAL) on volume                        │
│   job queue table + scheduler                   │
├─────────────────────────────────────────────────┤
│ onelight-worker (container, 1..N)               │
│   ffmpeg / ffprobe / audiowaveform / renderer   │
│   pulls jobs over HTTP from API                 │
├─────────────────────────────────────────────────┤
│ storage volume (originals + proxies)            │
│   - or S3-compatible endpoint (MinIO/R2/B2/AWS) │
└─────────────────────────────────────────────────┘
```

Reverse proxy (Caddy/Traefik/nginx) or Cloudflare Tunnel in front for TLS. GPU (NVENC) optional for the worker.

**B. Cloudflare (one-click + post-step)** - Worker (Hono) + R2 + D1 + Queues + Durable Objects + Container (ffmpeg). See §16.

**C. Hybrid private+public edge** - instance A runs on the studio LAN; a tiny public edge (a Worker or a tunnel-exposed reverse proxy) terminates review-link traffic only and proxies to the LAN instance over Cloudflare Tunnel/WireGuard. Internal users hit the LAN directly; clients hit `review.studio.com`. Implementation: the edge is *configuration* (route allowlist: `/s/*`, `/api/shares/*`, media URLs scoped to share tokens), not a second app. Ship as a documented recipe + optional `onelight-edge` Worker.

### 4.2 Ports & adapters

Everything platform-specific lives behind five interfaces in `packages/core`:

```ts
interface BlobStore {            // storage
  putStream(key, stream, meta): Promise<void>
  createMultipart(key, meta): Promise<{uploadId, partSize}>
  signPartUrl(key, uploadId, partNo): Promise<string>   // S3/R2; local impl returns API URLs
  completeMultipart(key, uploadId, parts): Promise<void>
  listParts(key, uploadId): Promise<Part[]>             // resume source of truth
  signGetUrl(key, opts: {expires, contentDisposition?}): Promise<string>
  getStream(key, range?): Promise<ReadableStream>
  delete(key): Promise<void>
}
interface Db { /* Drizzle instance; sqlite dialect */ }
interface JobQueue {
  enqueue(job: JobSpec): Promise<JobId>                 // idempotency key required
  // consumers: worker-pull loop (Node) / Queues consumer export (CF)
}
interface Transcoder {
  probe(source: BlobRef): Promise<MediaInfo>
  run(job: TranscodeJob): Promise<TranscodeResult>       // local ffmpeg | Container | Stream
}
interface RealtimeHub {
  publish(channel, event): Promise<void>
  subscribe(channel): EventStream                        // SSE fanout v1; room WS v2
}
```

Adapters:

| Port | Self-hosted | Cloudflare |
|---|---|---|
| BlobStore | local-disk; s3-compatible (aws4fetch - works on MinIO/AWS/B2/R2) | R2 via S3 API (same s3 adapter) or R2 binding |
| Db | better-sqlite3 / libsql | D1 |
| JobQueue | SQLite jobs table + in-process scheduler, workers pull over HTTP | Cloudflare Queues (+ R2 event notifications for upload-complete) |
| Transcoder | spawn ffmpeg in onelight-worker | same worker image as a CF Container; or Cloudflare Stream |
| RealtimeHub | in-process pub/sub -> SSE (Redis pub/sub when multi-node) | Durable Object per channel -> SSE/WS |

Rule: `packages/core` and all route handlers import only the ports. CI runs the API test suite against both adapter sets (miniflare/workerd for CF).

### 4.3 The worker image

One Docker image, `onelight-worker`, used identically as the self-hosted transcode worker and the Cloudflare Container. Contents: ffmpeg (with libplacebo, zscale, libx264, libx265, libsvtav1), ffprobe, audiowaveform (BBC, invoked as subprocess only - GPL isolation), poppler-utils (PDF rasters), libvips (stills), skia-canvas + Node runtime for annotation burn-in rendering, and a small HTTP job runner: `POST /jobs` with a signed job spec, progress via callback URL (HMAC), streams I/O directly from/to BlobStore URLs (never stages >20GB - CF Container disk limit; ffmpeg reads via HTTP range from presigned GET, writes via multipart PUT).

### 4.4 Monorepo

pnpm workspaces:

```
onelight/
  packages/
    core/        # domain logic, ports, timecode math, marker exporters, zod schemas
    db/          # drizzle schema + migrations (sqlite dialect)
    api/         # hono app (routes, auth, SSE) - platform-agnostic
    web/         # sveltekit SPA (adapter-static)
    player/      # the player as its own package (video engine, annotations, scopes)
    worker/      # transcode job runner (Node) -> docker image
    cli/         # onelight CLI (upload/download/sync/export)
    edge/        # optional CF edge worker for hybrid topology
  apps/
    server/      # Node entry: serves api + web build + local BlobStore endpoints
    cf/          # Workers entry: wrangler.jsonc, D1 migrations, DO classes, queue consumers, container class
  deploy/        # docker-compose.yml, Caddyfile examples, tunnel recipes
  docs/
```

TypeScript strict everywhere; zod schemas shared between API validation, OpenAPI generation, and the web client; the OpenAPI doc is generated from the Hono routes (`@hono/zod-openapi`) and published - API stability is a headline feature (frame.io's V4 API breakage is a documented wound).

## 5. Data model

SQLite dialect everywhere (better-sqlite3/libsql self-hosted, D1 on CF), via Drizzle. Rationale: review metadata is small (comments/projects/users - a busy facility won't approach D1's 10GB cap); one dialect means one schema, one migration set, one query surface. Postgres is a documented *future* adapter if a mid-size deployment ever outgrows SQLite write concurrency - the Drizzle schema is written to keep that port cheap (no SQLite-only cleverness in queries; ULIDs not AUTOINCREMENT).

Scale-out, stated precisely: with SQLite the API is a single node; horizontal scale today means adding transcode workers (stateless, scale freely) behind that node. Multi-node API requires the Postgres adapter (plus the Redis realtime fanout in §15). "Mid-size facility" is served by the single-node + many-workers shape; the Postgres path exists so that ceiling is a config migration, not a rewrite.

IDs: ULID strings. All tables carry `workspace_id` from day one (single-workspace UX in v1; the row exists at install). Times: epoch ms integers, UTC.

Core tables (abridged - full DDL lives in `packages/db`):

```
workspaces(id, name, settings_json)
users(id, workspace_id, email, name, password_hash?, role: admin|member, disabled_at?, created_at, ...)
identities(id, user_id, provider, subject)          -- external auth (OIDC); replaces a users.oidc_sub column
sessions(id, user_id, expires_at, ...)
api_tokens(id, user_id, name, hash, last_used_at)   -- scopes deferred; tokens carry the user's permissions

projects(id, workspace_id, name, status: active|archived, palette, restricted, settings_json)
project_members(project_id, user_id, role: manager|editor|commenter|viewer)

folders(id, project_id, parent_id?, name)
assets(id, project_id, folder_id?, kind: video|audio|image|pdf|file,
       current_version_id, name, status: none|in_review|approved|changes_requested)
asset_versions(id, asset_id, version_no, original_blob_key, original_filename,
       size, checksum_crc32c, uploaded_by, media_info_json,      -- full ffprobe capture
       source_timecode_start?, frame_rate_num, frame_rate_den, drop_frame,
       duration_frames, color_json,                              -- primaries/transfer/matrix/range
       transcode_status: pending|processing|ready|failed|skipped)
renditions(id, version_id, kind: proxy_2160|proxy_1080|proxy_540|hdr_hevc|hdr_av1|
       audio_peaks|sprite|poster|pdf_pages|still_tiles|watermarked,
       blob_key, meta_json, share_id?)                           -- share_id set for watermarked variants

comments(id, version_id, parent_id?, author_user_id?, author_name?, author_email?, -- anonymous authors
       frame_in, frame_out?,                                     -- integer frames, always
       body_text, annotation_json?,                              -- normalized-coords strokes/shapes; frame space or timeline-lane space
       pin_xy?, page_no?,                                        -- spatial pin; PDFs
       internal: bool, completed_at?, completed_by?,
       carried_from_comment_id?, deleted_at?, created_at, edited_at)
comment_attachments(id, comment_id, blob_key, filename, size)
comment_reads(comment_id, user_id, read_at)                      -- powers the "unread" filter
comment_reactions(comment_id, user_id, emoji)

shares(id, project_id, slug, kind: review|presentation, title, layout: grid|list|reel,
       passphrase_hash?, expires_at?, allow_download: none|proxy|original,
       allow_comments, show_all_versions, watermark_spec_json?, brand_json?,
       created_by, revoked_at?)
share_assets(share_id, asset_id, sort_order)
share_viewers(id, share_id, viewer_key, name?, email?, first_seen_at, last_seen_at,
       user_agent, view_state_json)                  -- analytics (per-asset view state) + WM identity;
                                                     -- viewer_key = signed per-share cookie value

jobs(id, kind, payload_json, idempotency_key, status, attempts, run_after,
     started_at?, finished_at?, error?, worker_id?)
webhooks(id, workspace_id, url, secret, events_json, active)
notifications(id, user_id, kind, payload_json, read_at?)
audit_log(id, workspace_id, actor, action, target, meta_json, at)
```

Key invariants:
- **Positions are integer frames** against the version's rational frame rate, never seconds. Seconds are derived at display/export time (§8).
- Comments belong to a *version*; "asset-level" comments are version comments with no anchor. Carrying forward to new versions is an explicit copy with provenance (`carried_from_comment_id`) so re-anchoring (Phase 7) has a data path.
- Originals are immutable blobs; renditions are disposable and re-derivable.
- `renditions.share_id` makes watermarked proxies per-share cacheable and revocable with the share.

Deletion, lifecycle, and retention:
- Assets and versions soft-delete into a per-project **trash** (`deleted_at`); default 30-day retention, then a purge job hard-deletes rows and cascades comments, renditions, share references, and blobs. Restore from trash is one click. Deleting a version mid-stack leaves `version_no` gaps (never renumber).
- Comments soft-delete (visible as "comment removed" placeholder inside threads, invisible elsewhere).
- Projects: archive is the soft path. **Archived** = read-only (no uploads, comments, or notifications; shares keep working unless revoked; hidden from the default wall filter). Hard delete is admin-only, requires typed confirmation, and enqueues blob purge.
- Users are never hard-deleted once they have authored anything; disable instead.
- Retention defaults (configurable): audit_log 2 years, jobs 90 days, notifications 180 days, share_viewers deleted with their share. Share viewer PII (name/email/IP) is deletable on request (admin action), satisfying GDPR-style asks.
- Storage accounting: per-project usage rolled up by the job system (originals + renditions bytes), surfaced on the dashboard and admin storage page; optional workspace quota (env) blocks new uploads past the cap with a clear error.

Blob key layout: `{workspace}/{project}/{asset}/{version}/original/{filename}` and `.../renditions/{kind}/...` - human-legible, so a bucket is comprehensible without the DB.

## 6. Media pipeline

### 6.1 Flow

```
upload complete ─► probe job ─► plan job (decides rendition set from media_info)
                                   ├─► proxy renditions (parallel)
                                   ├─► poster + sprite/filmstrip + VTT storyboard
                                   ├─► audio peaks (audiowaveform -> .dat)
                                   └─► (HDR sources) HDR rail + tonemapped SDR
     each job -> progress events -> SSE -> UI;  all jobs idempotent, resumable, prioritized
```

Priority: poster/sprite first (UI becomes browsable in seconds), 1080p proxy next, everything else after. Failure of one rendition never blocks others; `transcode_status=ready` when the primary proxy exists.

### 6.2 Probe

`ffprobe -show_format -show_streams -show_entries format_tags=timecode:stream_tags=timecode` captured verbatim into `media_info_json`. Extract: codec, dimensions, rational frame rate (`r_frame_rate` vs `avg_frame_rate` - mismatch ⇒ VFR flag), duration, bit depth, color primaries/transfer/matrix/range, audio channel layout, **start timecode from the tmcd track** (`;` ⇒ drop-frame). VFR detection: `-vf vfrdet`. Sources with no color tags get flagged `color_assumed: true` (assume BT.709 for HD+, BT.601 for SD) and the UI shows the assumption - colorists get honesty, not silent guessing.

### 6.3 SDR review proxy (the workhorse)

Progressive faststart MP4, **not HLS**, for v1. Research verdict: progressive MP4 gives a deterministic sample timeline (frame accuracy is trivial and provable); HLS packaging introduces PTS offsets that corrupt frame math (documented hls.js/MediaConvert cases) and buys nothing at review-scale file sizes. HLS/ABR is a Phase 7+ option for long-form, revisited only with PTS-alignment validation in CI.

Canonical 1080p recipe (per research / ASWF dailies guidance):

```
ffmpeg -i src \
  -vf "fps=<num>/<den>,scale=-2:1080,format=yuv420p" \        # CFR always; VFR dies here
  -c:v libx264 -preset slow -crf 18 -tune film \
  -profile:v high -level 4.2 -g 24 -keyint_min 24 -sc_threshold 0 \  # 1s GOP: snappy stepping
  -maxrate 12M -bufsize 24M \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 192k -ac 2 \
  -timecode <source_start_tc> -movflags +faststart out_1080.mp4
```

Rendition ladder by source: ≤1080p sources -> 1080p (CRF 18) + 540p (CRF 21); 4K+ sources -> add 2160p (CRF 19, `-level 5.2`). Same-as-source fps always. NVENC path (`h264_nvenc -rc vbr -cq 19`) auto-selected when the worker sees a GPU. 10-bit sources get correct dithering via `format=yuv420p` after any filtering, and the proxy always carries explicit 709/tv tags - **untagged output is the #1 review-tool color bug** (Safari assumes 601; QuickTime gamma shift). QC matrix in CI: golden-frame screenshots compared across Chrome/Safari/Firefox rendering of tagged output (§21).

### 6.4 HDR sources

Two renditions, always both:
- **HDR rail**: HEVC Main10 `-tag:v hvc1` (Safari/Chrome-HW) *and/or* AV1 10-bit (SVT-AV1; Chrome/Firefox/Edge), preserving source primaries/transfer (PQ or HLG), `mdcv`/`clli` passthrough. Codec choice per §19 royalty posture: AV1 preferred, HEVC where Safari matters.
- **Tonemapped SDR proxy** via libplacebo (`tonemapping=bt.2390`, correct HLG inverse-OOTF handling), labeled in the UI as "SDR preview (tone-mapped)". Optional per-project **supplied 3D LUT** for the SDR derive (the YouTube model - colorists distrust auto-tonemap).

Player-side gating in §7.4.

### 6.5 Sidecars

- **Poster**: middle frame or user-set (`set frame as thumbnail`).
- **Sprite/filmstrip**: `fps=1/2,scale=160:-2,tile=10x10` sheets + WebVTT storyboard with `#xywh=` fragments (denser than streaming-standard because review scrubbing is the point).
- **Audio peaks**: `audiowaveform -b 8 -z 256` -> binary `.dat`, rendered with peaks.js-compatible custom Svelte component.
- **Stills**: libvips -> sized JPEG/PNG previews; very large stills -> DZI tiles + OpenSeadragon-style deep zoom. EXR/DPX singles via oiiotool (`--colorconvert` OCIO) -> then vips.
- **PDFs**: poppler `pdftoppm` page rasters + pdf.js in the player; comments carry `page_no`.
- **Audio-only assets**: peaks + AAC proxy; player shows waveform timeline.

### 6.6 Job system

Jobs table is the queue (self-hosted); workers long-poll `GET /internal/jobs/next` with capability tags (`gpu`, `hdr`), heartbeat, at-least-once with idempotency keys; exponential backoff, max attempts, dead-letter status surfaced in an admin queue UI. On CF, the same job specs ride Cloudflare Queues and the Container runner (with explicit lifecycle: heartbeats + explicit stop, never bare `sleepAfter` - the documented Dodds footgun). Transcode concurrency, priorities, and per-project fairness are config.

**Blob garbage collection**: deletes are DB-first, blobs second (a purge job per §5 lifecycle). A weekly reconciliation job lists the bucket/volume against `blob_key` columns and deletes orphans older than 7 days (covers crashed purges, replaced renditions, and abandoned keys); it runs in dry-run mode by default on first enable and reports before it deletes. Incomplete multipart reaping per §14.

## 7. Player

The single most important surface. Lives in `packages/player` as a dependency-light Svelte 5 library.

### 7.1 Engine

- `<video>` element playing the progressive MP4 proxy; rendition switcher (quality menu, frame.io-style discrete renditions).
- **Frame clock**: `requestVideoFrameCallback`; current frame = `Math.round(mediaTime × num/den)` computed in rational math (never float fps). `currentTime` is never trusted for frame identity.
- **Stepping**: seek to frame middle - `t = (N + 0.5) × den/num` - then verify via the next rVFC `mediaTime`; nudge ±half frame and reseek if the decoder landed wrong. 1s GOPs make this feel instant.
- **Power-stepper (WebCodecs sidecar)**: mediabunny demuxer + `VideoDecoder` caching the current GOP for instant ±1 stepping, reverse play, and pixel access for scopes. Feature-gated; `<video>` path is always the fallback (Safari EME/rVFC quirks documented).
- **Transport**: J/K/L with 2×/4×/8× shuttle both directions, space, ←/-> ±1 frame, Shift±10, I/O range marks + loop, playback rate 0.25-2×, `preservesPitch` on.
- **Audio scrub**: decoded `AudioBuffer` + one-shot grain playback (20-80ms grains, gain crossfades) for true bidirectional scrubbing; `playbackRate` handles J/K/L shuttle audio.
- Hover-scrub via sprite storyboard on the timeline and on asset cards.
- Timeline: filmstrip strip + waveform lane + comment markers (range comments render as spans), zoomable.
- Frame guides/masking (2.39, 1.85, 9×16 etc.), safe areas, current-frame still download (PNG from proxy; original-res via server extract job).
- Keyboard map published and frame.io-compatible where sane.

### 7.2 Dropped-frame honesty

`presentedFrames` deltas detect compositor drops; the frame counter never lies (it reads `mediaTime`, not a rAF estimate). If the display can't keep up (e.g. 60p on a 60Hz screen with load), we show real frames presented.

### 7.3 Annotations overlay

Transparent canvas above the video (SDR canvas over HDR video composites correctly today - this is also why HDR ink works). Coordinates normalized 0-1 against `videoWidth/Height`; render-time mapping through the `object-fit: contain` content rect; `devicePixelRatio`-sized backing store. Ink via perfect-freehand (deterministic outline from `[x,y,pressure]` points - same renderer runs in the browser and in the server burn-in path). Tools: pen, line, arrow, rect, ellipse, text; color palette; undo/redo. Strokes stored as input points + tool metadata in `annotation_json` (§9).

### 7.4 HDR playback gating

```
canHDR = mediaCapabilities.decodingInfo({video: {codec, hdrMetadataType:'smpteSt2086',
          colorGamut:'rec2020', transferFunction:'pq'}}).supported
       && matchMedia('(dynamic-range: high)').matches      // Chrome lies without this
```

Firefox -> SDR unconditionally (documented broken HDR render). HEVC rail served as `hvc1` only. UI labels the active rail; `change` listener re-evaluates when the window moves displays. Fallback is always the tonemapped SDR proxy, labeled.

## 8. Timecode

`packages/core/timecode`: a small, exhaustively-tested module - this is a *correctness brand* for the project.

- Internal truth: `{frames: int, rate: {num, den}, dropFrame: bool, startTC: frames}`.
- NDF/DF conversion per SMPTE ST 12-1 with the verified Heidelberger/Duncan algorithms (DF only at 29.97/59.94; **no 23.976 DF exists**; reject invalid DF labels like `xx:xx:00;01`).
- Display = `startTC + frameIndex` rendered per rate; `;` separators for DF.
- Toggle: source TC / record-run (00:00:00:00-based) / frames / seconds.
- Source start TC from tmcd (§6.2) re-embedded into proxies (`-timecode`), so downloads stay conformable.
- Property tests: round-trip every frame index ↔ label for a full 24h at every supported rate (24000/1001, 24, 25, 30000/1001 DF/NDF, 48, 50, 60000/1001 DF/NDF, 60).

## 9. Comments & annotations

The heart of the product; feature-complete against frame.io V4's model in v1:

- **Anchors**: single frame (`frame_in`), range (`frame_in..frame_out` via I/O + R), spatial pin (`pin_xy`), drawing (annotation strokes in frame space), timeline-lane drawing (strokes in timeline space: x = frame number, y = lane height; created by drawing directly on the timeline's notes lane), PDF page, or asset-level (no anchor). Range comments render on the timeline notes lane as labeled bands gated to their TC span, and the comment panel can filter to "active at playhead".
- Threaded replies (one level), @mentions (project members only in v1; named share viewers are not mentionable), emoji reactions, #hashtags (indexed, filterable).
- **Statuses**: per-comment "complete" (who/when); per-asset approval status (`in_review/approved/changes_requested`) with an unambiguous client-facing Approve control on shares.
- **Internal comments**: flag on any comment; *never* serialized into share-scoped API responses (enforced at the query layer, tested - this is a trust feature).
- Anonymous authors: share viewers comment after a name(+email) prompt; stored on the comment, promoted to a real user if they later get an account.
- Filters/sorts: timecode, newest, author, completed, has-annotation, has-attachment, hashtag, unread. Exports respect active filters (deliberate frame.io parity).
- Attachments per comment (stored as blobs, size-capped).
- Editing with `edited_at`, soft-delete, full audit trail.
- Live updates via SSE (§15); deep links `/p/{project}/a/{asset}?v=3&c={comment}` land on version 3 at the comment's frame with the drawing visible.

## 10. Versions & comparison

- **Version stacks**: drag-onto-asset or explicit "upload new version"; `version_no` monotonic; stack reorder; per-version comments; shares can expose all versions or latest-only.
- **Carry-forward (v1)**: one-click copy of unresolved comments to the new version (same frame number), provenance-tracked, badge "carried from v2". (Auto re-anchoring across cuts is Phase 7 - perceptual-hash frame matching; the schema is ready.)
- **Comparison viewer (Phase 4)**: two assets/versions side-by-side with linked playhead + linked zoom/pan, comment on either side; images add overlay slider + pixel-diff mode. Synced by shared frame clock - trivial with the frame-based player engine.

## 11. Sharing, presentation & watermarking

- **Shares** (one model, two kinds - mirroring frame.io V4's consolidation): `review` (comment-first) and `presentation` (branded, curated, reel/grid/list layouts).
- Controls per share: passphrase (argon2 hash), expiry, revoke, allow_comments, allow_download (**none / proxy / original** - explicit, because "client downloaded the 480p proxy and delivered it" is a documented industry trauma), show_all_versions, per-share branding (logo, colors, background).
- Share slugs are 22-char base62 (~128-bit) random strings; unguessable by construction, rate limits still apply to passphrase attempts and anonymous comment posting (per share + IP). Superseded 2026-07-16: new slugs read as the kebab-cased title plus 14 base62 chars (~83 bits), which stays far beyond enumeration while making the link say what it opens; old slugs keep resolving, since lookups were always by exact slug.
- Anonymous access with named-viewer prompt; identity persists as a signed per-share cookie (`viewer_key`), so a returning viewer keeps their name and can edit or delete their own comments while the cookie lives. Re-prompt on a new device is accepted (spoofable identity is inherent to account-free review; the watermark carries the claimed identity). Promotion to a real user happens by email match at account creation.
- `share_viewers` powers analytics (viewed/commented/downloaded, per-asset view state) and watermark identity.
- **Watermarking**:
  - *Burned per-link* (v1): share with `watermark_spec_json` triggers a watermarked proxy rendition per asset (drawtext/overlay: custom string, client name, logo, position/opacity), cached under `renditions(share_id)`, invalidated on spec change or revoke.
  - *Session overlay* (v1): client-side overlay of viewer email/IP/timestamp on top (deterrent-grade, like Chromatic - documented honestly as DevTools-removable).
  - *Per-session burned* (Phase 7 option): pre-burned segment variants or on-the-fly stamping; forensic-grade is out of scope.
- Share pages are served by the SPA with server-generated OpenGraph meta (poster og:image) via a tiny render route on the API, so links unfurl nicely in Slack/iMessage - clients judge tools by this.
- Notifications: in-app notification center (the `notifications` table, mark-read, badge) plus email via SMTP config. Emails reference proper `Message-ID`/`In-Reply-To` headers so clients thread them, and deep-link to the comment; inbound reply-by-email is NOT v1 (requires an inbound mail path; revisit with a provider-webhook design later). Per-user preferences: per-project mute, and delivery mode instant / hourly digest / daily digest (frame.io broke notification controls in V4; we won't). A 200-note review pass must not send 200 emails: comment emails within a digest window collapse.

## 12. NLE round-trip

File-based exports ship in **v1** (`packages/core/markers`, golden-file tested against real NLE imports):

| Target | Format | Notes (research-verified syntax) |
|---|---|---|
| Resolve | Marker EDL (`TITLE:`/`FCM:` + `|C:ResolveColor |M:note |D:dur`) | **Preserve comment text** (fixes frame.io's dropped-text bug); sanitize: no leading digits (`_` prefix), ASCII-only, collapse same-frame collisions |
| Avid | Tab-separated marker .txt + Avid Marker XML | Round-trip a real MC export before shipping (trailing-field semantics) |
| Premiere | FCP7 XML (xmeml) sequence markers | Native CSV import doesn't exist; xmeml does |
| FCPX | FCPXML `<marker start="N/Ds">` rational times | |
| Generic | CSV, plain text, JSON | |
| PDF report | Per-comment annotated frame grabs (server burn-in renderer) + thread text | The client-deliverable |

Exports respect comment filters; range comments become duration markers; timecode base = source TC with record-run option (must match the user's timeline start or Resolve misaligns - surfaced in the export dialog).

**Phase 6 - native panels**:
- **Resolve first** (vacated niche): Workflow Integration plugin (JS/CEF) + scripting API - browse projects, pull comments as timeline markers live, push renders up as new versions with metadata. Ships in the repo with an installer.
- **Premiere**: UXP panel - comments-to-sequence-markers, upload active sequence export. 
- Both consume the same public REST API + API tokens (no private endpoints - the community can build the AE/FCP/Nuke ones).

## 13. Auth, permissions & security

- Email/password (argon2id self-hosted; see phase-0 spec for the Workers PBKDF2 rule) + invites; **OIDC** generic provider config (issuer/client/secret; tested against Authentik, Keycloak, Google, Entra); optional auto-provision by email domain. Passkeys post-v1. Sessions: httpOnly cookies + origin-checked mutations; API tokens (hashed) for CLI/panels/CI.
- Password reset: Phase 0 ships an admin CLI (`reset-password <email>`, prints a one-time password) so a locked-out admin always has an escape hatch; the emailed self-service reset flow ships with SMTP in Phase 2.
- Session management: users can list and revoke their active sessions (device, IP, last seen) in settings (Phase 2); password change revokes all other sessions (Phase 0).
- Roles: workspace `admin|member`; per-project `manager|editor|commenter|viewer`; share-scoped anonymous grants. Restricted projects (invite-only, no workspace-wide visibility) in v1 - small schema cost, big trust win.
- Media URL security: **signed, expiring URLs for every blob read**; no unauthenticated bucket paths, ever. TTL 15 minutes; the player refreshes URLs transparently before expiry (and on a 403) so a two-hour session never stalls. Share media is signed with share-scoped tokens, so revoking a share invalidates new URL issuance immediately and already-issued URLs die within the TTL. Range requests supported throughout (video seeking).
- Rate limits on auth, share-passphrase attempts, and anonymous comment posting; audit log of auth/share/download events; webhook signatures HMAC-SHA256 with retries/backoff (frame.io parity).
- Self-host hardening docs: reverse-proxy TLS, tunnel recipe, backup guidance (SQLite: Litestream/snapshot; blobs: rclone), restore drill documented.
- Upgrades: migrations are forward-only and run at boot; the app refuses to start against a schema newer than itself; workers send their version with every job claim and the API rejects mismatched majors (no silent job-spec skew during rolling upgrades); release notes flag any migration that needs a backup first (the docs say: always snapshot before upgrading anyway).
- **Telemetry: none.** No phone-home, no crash reporting, no usage analytics, ever. Update awareness is a manual "check for updates" action that fetches a static version file, off by default.
- Optional ClamAV hook on upload complete (post-v1).

## 14. Uploads

- **Client**: Uppy dashboard (`@uppy/aws-s3` with `shouldUseMultipart` >100MiB) wired to Onelight endpoints: `createMultipartUpload / signPart / listParts / complete / abort`. Resume across reloads via `listParts` (storage is the source of truth). Part size is fixed **per upload** (R2 requires uniform parts): 16 MiB default, scaled up in power-of-two steps when `fileSize / 16MiB` would exceed 9,500 parts (a 1 TB file uses 128 MiB parts). Ceiling: ~4.995 TiB per object on R2 (the R2 object cap), ~48 TiB on S3; the uploader rejects larger files with a clear error.
- **Integrity**: CRC32C full-object checksums computed incrementally in a Web Worker (hash-wasm) on the same read pass as slicing; verified server-side (S3 `FULL_OBJECT` mode where supported; local adapter verifies directly).
- **Folder uploads**: `webkitdirectory` (Baseline) + drag-drop `webkitGetAsEntry` recursion (100-entries-per-`readEntries` loop) + File System Access API on Chromium (persistent handles -> resumable folder sessions). Manifest-first: client posts the file list, server returns keys+URLs, resume-by-diff. Structure preserved; `webkitRelativePath` sanitized.
- **Local-disk adapter**: same client protocol; "presigned part URLs" are short-lived signed API URLs (`PUT /api/uploads/{id}/parts/{n}`) streamed to disk - no MinIO dependency for the small self-hoster; body-size limits bypassed by part-sized chunks.
- Lifecycle: incomplete multiparts reaped after 7 days (R2 default; lifecycle rule on S3; cron job locally). Upload sessions survive API restarts.
- Camera-card realities: 500+ file batches, batch presigning (200 keys/call), bounded concurrency (6-10 parts in flight globally), per-file retry with backoff, quarantine state for checksum mismatches.
- Post-v1: watch-folder desktop agent + CLI `onelight push` (same manifest protocol), C2C-style device ingest endpoints (pairing codes, auto-foldering by device/date - the frame.io C2C semantic of proxy filename/TC matching camera originals is the design bar).

## 15. Realtime

- **v1: SSE** (`RealtimeHub` port): per-project and per-asset event streams (comment created/edited, transcode progress, approval changes) over `@microsoft/fetch-event-source`-style client (auth headers + `Last-Event-ID` resume). HTTP/2 makes SSE connection limits a non-issue; writes are plain REST. In-process fanout single-node; Redis pub/sub adapter when scaled out; Durable Object fanout on CF.
- **v2: rooms** (presence + watch-together): one room per asset - WebSocket on Node (`ws`), Durable Object with Hibernation on CF (hibernation discipline: no held outbound sockets, auto-response pings - or costs 100×). Synced playback per Syncplay-verified constants adapted for review precision: leader state `{playing, mediaTime, atServerTime, rate}` + 1s ticks; followers rate-nudge 0.95-1.05× inside ~1-2s drift, hard-seek beyond; NTP-over-WS clock sync (median of N ping-pongs). Live mirrored drawing (ephemeral strokes over the room channel) rides the same room. CRDTs deliberately avoided - comments are LWW single-author; Yjs only if simultaneous co-drawing on one canvas ever becomes a goal.

## 16. Cloudflare deployment target

Research-verified architecture (all GA as of mid-2026):

```
browser ──presigned multipart──► R2 ──event notification──► Queue ──► Worker consumer
                                                                        │ wakes
Worker (Hono API, same code) ◄──D1 (metadata)                 Container (onelight-worker image)
   │ SSE/WS via Durable Objects                                  │ ffmpeg reads R2 via HTTP range
   └── serves SPA from Workers Assets                            └─ multipart-PUTs renditions to R2
```

Constraints designed around (verified): 100MB Worker request body -> uploads never proxy through the Worker; R2 uniform part sizes; Container 20GB ephemeral disk -> stream-through ffmpeg, never stage originals; D1 10GB cap (fine for metadata); DO hibernation billing discipline.

**One-click**: Deploy-to-Cloudflare button provisions Worker + R2 + D1 + Queues + DOs + secrets, runs D1 migrations, sets up R2 event notification rules via `postdeploy` script. **Containers can't be button-provisioned** -> two documented paths behind the `Transcoder` port:
1. `npx wrangler deploy` post-step (requires local Docker) adds the ffmpeg Container - the full-fidelity path;
2. config-flip to **Cloudflare Stream** as managed transcode/playback (per-minute billing, zero infra) - accepts a second player path (Stream HLS) as the price of zero-Docker onboarding.

Until either lands, the instance runs in honest degraded mode: originals playable where browsers can (H.264 MP4s), posters/sprites via Media Transformations binding.

Cost reality documented for users: ~$63-70/mo at 2TB stored / 500GB monthly ingest / typical review traffic; storage dominates; egress $0. (Same profile on S3+CloudFront: ~$170/mo.)

Wrangler config, DO classes, queue consumers, and the Container class live in `apps/cf`; CI runs the API suite under workerd.

## 17. API, CLI & ecosystem

- **REST API is the product's contract**: `/api/v1/*`, OpenAPI generated from zod route schemas, published docs, semantic versioning, deprecation policy in writing (the anti-frame.io stance). Cursor pagination, idempotency keys on mutating endpoints, webhooks with HMAC + retries.
- **CLI** (`packages/cli`): `onelight push/pull/sync/status/export-markers` - token auth, manifest-resumable transfers, watch mode (`--watch` = the v1 watch-folder story), JSON output for scripting.
- **Webhooks**: asset.uploaded, version.ready, comment.created/completed, share.viewed, approval.changed.
- Panels (Phase 6) consume the same public API. Community integration surface is explicit: API tokens + webhooks + OpenAPI + AGPL.
- Transcription (Phase 7): whisper.cpp in the worker image (Workers AI on CF) -> searchable transcript panel + SRT/VTT export. Cheap win; frame.io gates nothing here anymore, but self-hosted transcription is a privacy win.

## 18. Color-critical mode

The halideworks differentiator, phased:

- **Phase 1-3 (v1)**: correctness everywhere - explicit color tags on every rendition, VFR->CFR, tmcd preservation, gamma-shift QC across browsers, honest "assumed 709" flagging, HDR sources get gated HDR rail + labeled tonemapped SDR (§6.4, §7.4).
- **Phase 7 (reference mode)**:
  - High-bitrate 10-bit HEVC/AV1 "reference proxy" rendition (CRF ~14, 4:2:0 10-bit; the "trust this for color notes" tier);
  - **Scopes**: WebCodecs -> WebGPU compute (waveform/vectorscope/histogram/false-color) on the actual decoded pixels - including HDR pixels via `importExternalTexture` + PQ/HLG shader math;
  - **LUT preview**: client-side 3D LUT application (WebGPU) for "how would this look through the show LUT" review;
  - Display capability report (what the viewer's browser/display can actually reproduce, surfaced to the comment thread - "client viewed on SDR laptop" context on every comment);
  - Still-frame color-managed export (tagged PNG/TIFF16 from original via server job).

## 19. Licensing & legal landmines

| Item | Risk | Posture |
|---|---|---|
| Onelight itself | - | **AGPL-3.0**; CLA-free, DCO sign-offs; trademark "Onelight" reserved by halideworks |
| H.264 (libx264) | Low (patents expiring; ubiquitous decode) | Default codec everywhere |
| HEVC | **High at scale** - Access Advance absorbed Via LA pools (Dec 2025); VDP pool claims streaming-distribution royalties on HEVC/VVC/**AV1**/VP9 | HEVC only where HDR+Safari forces it; ship via user's ffmpeg build; document; monitor VDP |
| AV1 | Low-med (AOM royalty-free; Sisvel/VDP contest edges) | Preferred HDR rail |
| ffmpeg ProRes/DNx decode | Low (universal practice) | Decode freely; never advertise ProRes *encoding* as a service without Apple certification |
| R3D SDK | **High** - SaaS/cloud use unaddressed, instant-termination clause | No R3D in core. Optional self-hosted plugin *only after* written clearance from RED/Nikon |
| BRAW SDK | Medium - free but proprietary EULA, redistribution unverified | Read EULA before Phase 7 plugin; ship as user-installed optional component, never redistributed |
| audiowaveform (GPL-3.0) | Low | Subprocess-only in the worker image (AGPL app + GPL tool coexist fine as separate programs) |
| tldraw | License-key requirement | Avoided - perfect-freehand (MIT) + own tools |
| ffmpeg builds | LGPL/GPL config matters | Worker image builds ffmpeg with a documented, redistributable configuration |

## 20. Build plan

Phases are dependency-ordered; each has a demoable milestone and acceptance criteria. v1 = Phases 0-3. No calendar dates - this is scope, not schedule.

### Phase 0 - Foundations
Monorepo, CI (lint/typecheck/test on Node + workerd), `packages/core` ports, Drizzle schema + migrations, Hono skeleton with OpenAPI generation, auth (email/password, sessions, invites, OIDC, rate limiting, API tokens, admin reset-password CLI), workspace/project/folder/member CRUD, audit log, SvelteKit SPA shell (auth, project browser), docker-compose with Caddy example, seed/demo data command. Full detail: `specs/phase-0.md`.
**Milestone**: `docker compose up` -> log in via password *and* via Authentik -> create project -> invite member.
**Acceptance**: API suite green on both better-sqlite3 and D1(miniflare); OpenAPI doc published; restricted projects enforced in tests.

### Phase 1 - Ingest & pipeline
BlobStore (local-disk + s3) with multipart + signing; Uppy uploader (files, folders, resume, CRC32C); jobs table + scheduler + worker long-poll protocol; onelight-worker image (ffprobe probe, SDR proxy ladder, poster, sprites+VTT, peaks, PDF/still/audio handling); tmcd extraction + re-embed; VFR->CFR; transcode progress over SSE; admin queue UI; incomplete-upload reaping; storage usage accounting + blob GC reconciliation (dry-run first); asset trash (soft-delete/restore/purge per §5).
**Milestone**: drag a camera-card folder in -> browsable, hover-scrubbable, playable proxies with correct start TC.
**Acceptance**: kill the browser mid-50GB-upload, resume completes with matching checksum; kill the worker mid-job, job retries idempotently; proxies of a 23.976 ProRes with 01:00:00:00 tmcd show frame-exact TC; golden-file color QC passes (tagged 709, no gamma shift vs reference PNG in Chrome/Safari/Firefox).

### Phase 2 - Player, comments, versions
`packages/player`: rVFC frame clock, stepping with verify, J/K/L shuttle, I/O+loop, timeline (filmstrip+waveform+markers+notes lane), audio grain scrub, rendition switcher, frame guides, still export; annotation overlay (perfect-freehand tools, normalized coords); comments (all anchor types incl. timeline-lane drawing, threads, mentions, reactions, hashtags, internal flag, statuses, filters); asset browser (thumbnail grid + detail list, sortable columns, inline/batch rename, multi-select batch ops, drag-move/stack, context menus per §24.7); search (SQLite FTS5 over asset names, comments, hashtags; LIKE fallback where FTS5 unavailable); SSE live updates; version stacks + carry-forward; asset approval states; notifications (notification center + SMTP email, digests, prefs; self-service password reset); session management UI; deep links.
**Milestone**: full internal review loop - two users comment/draw/resolve on v1 and v2 of a spot, live.
**Acceptance**: frame counter matches ffmpeg-extracted frame at 20 random seeks across all supported rates (automated via WebCodecs ground truth); 24h property tests for TC math; internal comments provably absent from share-scoped responses; stepping latency <100ms p95 on the 1080p proxy.

### Phase 3 - Sharing & exports (v1 ships here)
Shares (review + presentation kinds, all controls: passphrase/expiry/downloads/comments/versions/branding/layouts); anonymous viewer flow with name prompt; share analytics; burned-per-link watermark renditions + session overlay; OG unfurls; marker exporters (Resolve EDL w/ text, Avid txt+XML, xmeml, FCPXML, CSV, plain text) + PDF comment report with burned-in annotation frame grabs; export dialog with TC-base selection; webhooks; audit log; hybrid-edge recipe docs; backup/restore docs; hardening pass (rate limits, signed media URLs everywhere).
**Milestone**: send a real client a passworded, watermarked presentation link; import their notes into Resolve as markers with full text.
**Acceptance**: each marker format imports cleanly into its real NLE (manual golden-file protocol documented + recorded); watermarked proxy renders per spec and invalidates on revoke; share passphrase brute-force rate-limited; a revoked share 404s immediately for new requests and previously issued media URLs expire within the 15-minute signing TTL (§13). **Tag v1.0.**

### Phase 4 - Realtime collaboration
Room abstraction (ws on Node); presence (who's viewing, where their playhead is); live comment/typing indicators; watch-together (leader/follower, rate-nudge sync, clock sync); live mirrored drawing (ephemeral strokes); comparison viewer (side-by-side synced + image overlay/diff).
**Milestone**: three people watch a cut in sync (±2 frames), one drives, drawings mirror live.
**Acceptance**: measured sync drift ≤2 frames p95 on 100ms-RTT links; rooms survive server restart (state rebuild); SSE fallback when WS blocked.

### Phase 5 - Cloudflare target
`apps/cf`: Workers entry, D1 adapter proving, R2 event-notification -> Queues -> Container pipeline, DO realtime hub (hibernation-disciplined), Workers Assets SPA serving, Stream Transcoder adapter + player path, Deploy button (public repo, wrangler.jsonc resources, postdeploy scripts), degraded-mode UX, cost documentation, CF e2e in CI (miniflare + a live staging account).
**Milestone**: click the button -> working instance on `*.workers.dev` with R2 uploads; run the post-step -> full transcode pipeline; flip config -> Stream backend.
**Acceptance**: same API test suite green against the deployed CF stack; a 100GB upload lands in R2 without touching the Worker body limit; Container jobs never stage >15GB on disk; DO idle cost ≈ $0 verified over a week.

### Phase 6 - Ecosystem
CLI (`push/pull/sync/watch/export-markers/export/import`; export/import = whole-project or whole-instance portability: JSONL metadata + blob manifest, and the CF-to-self-hosted migration path); **Resolve Workflow Integration plugin** (browse, pull comments as markers live, push renders as versions); Premiere UXP panel; desktop transfer/watch app (Tauri; wraps the CLI engine, adds tray + queue UI); C2C-style device ingest (pairing codes, device auto-foldering, TC/filename-preserving proxy semantics).
**Milestone**: colorist pulls client notes onto the Resolve timeline without leaving Resolve; a DIT's watch folder auto-populates dailies from set.
**Acceptance**: panels use only public API+tokens; marker text/TC verified frame-exact in Resolve/Premiere; transfer app survives sleep/network-change mid-100GB sync.

### Phase 7 - Color-critical & intelligence
Reference-mode proxies; WebGPU scopes (incl. HDR pixels) + false color; LUT preview; display-capability context on comments; comment auto re-anchoring across versions (perceptual-hash frame matching); whisper transcription + transcript search + SRT/VTT; per-session burned watermarking option; HLS/ABR option for long-form (with PTS-alignment CI); image-sequence ingest (EXR/DPX via oiiotool/OCIO); BRAW/R3D optional plugins pending licensing clearance.
**Milestone**: the review no other tool can do - HDR spot with scopes, show-LUT preview, and notes that survived three recuts.

## 21. Testing strategy

- **Unit**: timecode (property tests, all rates, 24h round-trips), marker serializers (golden files), annotation geometry, permission matrix (every role × every route).
- **Adapter contract tests**: one suite runs against every BlobStore/Db/JobQueue/Transcoder/RealtimeHub implementation (Node + miniflare/workerd in CI; live CF staging nightly).
- **Pipeline fixtures**: a curated media corpus (23.976/29.97DF/25/50/59.94 ProRes/DNx/XAVC/H.264, HDR PQ+HLG, VFR phone clip, tmcd'd MOV, 8ch audio MXF, EXR/DPX stills, broken/truncated files) transcoded in CI; assertions on frame counts, TC, color tags, duration.
- **Color QC**: headless Chrome/Firefox + WebKit screenshot comparison of golden frames vs reference renders (catches gamma/range regressions - the bug class users punish hardest).
- **Player e2e**: Playwright - frame-step accuracy vs WebCodecs ground truth, comment flows, share flows (anonymous path), upload resume (network-throttled, tab-killed).
- **Accessibility**: axe checks in Playwright on working-UI surfaces; contrast assertions for text-over-gradient scrims (§24).
- **NLE round-trip**: documented manual protocol per release (import each format into real Resolve/Avid/Premiere/FCP; recorded checklist) - automation isn't honest here.
- **Load**: k6 on comment fan-out + concurrent playback; upload soak (500-file card, throttled).

## 22. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Scope: "full frame.io" is a multi-year surface | High | Hard v1 line (Phases 0-3); every phase independently shippable; table-stakes list frozen against the research inventory |
| Frame accuracy edge cases (VFR, odd rates, broken muxes) erode the core promise | High | CFR-always proxies, corpus CI, WebCodecs ground-truth harness, honest UI when sources lie |
| Color/gamma regressions destroy credibility with the exact target audience | High | Explicit tags everywhere, screenshot QC in CI, "assumed" flagging, colorist beta cohort |
| CF platform drift (Containers pricing/limits, button capabilities) | Medium | Everything behind ports; Stream fallback; self-hosted is primary; re-verify CF facts at Phase 5 start |
| HEVC/VDP royalty exposure | Medium | AV1-first HDR, HEVC optional, distribution via user-built/user-pulled ffmpeg, legal review before any hosted offering |
| Single-maintainer burnout (the documented OSS-review-tool death) | Medium | Boring tech, adapter-tested seams, contributor docs from Phase 0, small deps, AGPL keeps forks honest |
| Uppy/mediabunny/perfect-freehand dependency health | Low | All replaceable behind local wrappers; player engine owns its abstractions |
| Upgrade skew (API vs worker image, bad migration on a live instance) | Medium | Forward-only migrations, version handshake on job claims, refuse-to-boot on newer schema, snapshot-before-upgrade doctrine (§13) |
| SQLite write contention at facility scale | Low-Med | WAL + single-writer job scheduler; documented Postgres adapter escape hatch; D1 proves the dialect discipline |

## 23. Open questions

Tracked here; none block Phase 0-1:

1. Postgres adapter timing - demand-driven; revisit after first mid-size deployment report.
2. Stream-backend player unification (Stream HLS vs our MP4 player) - accept divergence or write an HLS mode early?
3. Desktop app framework (Tauri assumed; confirm at Phase 6 against watch-folder filesystem-event needs).
4. Passkeys priority.
5. Hosted halideworks offering (would fund development; AGPL permits it; changes nothing architecturally - multi-workspace schema already exists).
6. Brand/domain check for "Onelight" (onelight.app availability, trademark search) - do before public repo.
7. Whether Phase 4 (realtime) and Phase 5 (CF) swap order - decide by community pull after v1.
8. Structured custom metadata fields (frame.io-style field library: select/date/rating/assignee columns) - v1 ships freeform description + tags on assets; decide the structured system's shape by Phase 7.
9. Default workspace quota semantics (hard block vs warn-only) and whether per-project quotas are worth having.
10. Caption/subtitle sidecar display (upload SRT/VTT alongside a version, render in player) - cheap, probably Phase 2; confirm priority.

---

## 24. UI design language

Established through mockup iteration with David (2026-07, living reference: `reviewer/mockups/`, palette catalog: `reviewer/gradients/PALETTES.md`). The goal register: crafted and intentional, like a Japanese awwwards-winning studio built it. Anti-references: frame.io (cluttered), Vimeo (toddler tool), Evercast (corporate).

### 24.1 Two worlds, hard boundary

1. **The review room** (player, comparison viewer, any surface within sight of pixels being judged): strictly neutral greys, R=G=B at every step, no gradients, no tinted chrome anywhere near the frame. Muted desaturated functional colors only (markers, statuses). A viewing-environment control sits in the transport: surround = Dark (near-black) / 18% Grey / Black. This is a professional-correctness feature, not a theme.
2. **Everywhere else** (dashboard, project browser, shares, presentation pages, auth, settings): dark ink base with Japanese gradient washes. This is where the product is beautiful.

### 24.2 Gradient system

- Source palettes: the nuevo.tokyo Japanese gradient library (23 cards, three-stop pairs of traditional nihon-no-dentoshoku colors, cataloged with hex in PALETTES.md). David can supply more.
- One grammar everywhere: vertical linear, dark anchor at top, light terminal at bottom, stops at 0% / ~55% / ~105%. No radials, no hard splits, no direction mixing.
- **Project identity**: every project is assigned a palette pair (user-pickable, default rotation). It becomes the project's card wash, interior header tint, and the default theme for its share links. The palette's romaji name is shown quietly on the card.
- **Client theming**: share/presentation pages take any library palette or two custom hexes plus logo.
- Gradients never appear in the review room, on thumbnails, or behind footage.

### 24.3 Motion

Budget: one slow ambient behavior per page, plus fast hover responses. The project wall "breathes": each card's gradient drifts through its tonal range on a ~16s ease cycle, out of phase with its neighbors; hover eases the gradient toward the viewer and pauses the drift. All motion respects `prefers-reduced-motion`. No springs, no bounces, no entrance animations.

### 24.4 Chrome rules (anti-slop, enforced)

- No emojis, no em dashes, anywhere (UI copy, docs, commit messages).
- No gradient border highlights, no glassmorphism, no glow shadows, no Inter, no decorative monospace labels, no random italics, no uppercase-tracked microcopy.
- **Borders are exceptional.** Separation is value steps and spacing. Legitimate lines: the reply-thread rule, annotation strokes, focus outlines. Everything else earns separation through fill contrast.
- Radii small (2-4px working UI, 6px cards). Shadows effectively absent.
- Empty space must be intentional (composition) or informational (fill it with operational truth: attention queues, activity feeds); never leftover margin.

### 24.5 Type

- **Display**: Space Grotesk (titles, wordmark, hero type, project card names). Ties the halideworks family together with Chromatic and has personality at size.
- **Working UI**: Switzer (quiet Swiss grotesque, Fontshare). Weight does the talking; the review room uses only this face.
- **Timecode/numerics**: tabular figures (`font-variant-numeric: tabular-nums`) on every numeric readout so digits do not shimmer during playback. Functional, not decorative; no monospace fonts for labels.
- Size floor: nav and secondary text at 13-14px; 11-12px reserved for true captions.
- Density: review room tight and instrument-like; browsing surfaces airy with generous display type.
- Times render in the viewer's local timezone via Intl (relative for recent, absolute on hover); share expiry is an absolute instant displayed with its timezone. v1 ships English only with UI strings centralized for later i18n.
- Accessibility: WCAG 2.1 AA target on working UI; text over gradients always sits on a scrim meeting contrast; full keyboard operability is a §24.7 requirement, not an afterthought; axe checks in CI (§21).

### 24.6 Color tokens

- Review room neutral scale: `#0a0a0a` to `#e9e9e9`, plus `#767676` as the 18% surround
  (linear 0.18 through the sRGB transfer curve is 0.4613, i.e. 118/255; the `#7a7a7a` this
  originally specified is ~19.6% and was the source of the wrong value in the code).
- App world base: near-neutral ink blues derived from the palette library's dark stops (`#0d1117` family).
- Single app accent: rokusho verdigris `#48929B` (primary actions, focus, links). Functional colors desaturated: ok `#6f8f6f`, note `#b09566`, warn `#a5605a`, info `#6f83a0`.

### 24.7 Pro-organization surface (spec requirements)

Everything a working editor expects from a file browser, keyboard-first:

- View modes per folder: thumbnail grid (hover-scrub) and detail list with sortable columns (name, duration, start TC, codec, resolution, fps, size, status, uploaded by, date).
- Inline rename (double-click or F2), batch rename with patterns.
- Multi-select (click ranges, marquee, select-all) with batch operations: move, stack as versions, set status, add to share, download, delete.
- Drag and drop: to folders, onto assets (creates version stacks), out of the app where the platform allows.
- Right-click context menus on every object; every menu action has a keyboard path.
- Search everywhere reachable via one shortcut: asset names, comment text, hashtags, project names (FTS5-backed, Phase 2).
- Freeform description + tags on assets in v1; structured custom metadata fields are an open question (§23).
- The timeline notes lane (§9): range comments as gated bands, freehand lane drawing creating range notes.

---

*Research basis: three deep-research reports (frame.io V4 feature inventory & competitive landscape; browser playback & transcode pipeline state of the art; Cloudflare platform feasibility), 2026-07-01, ~500 sources. Key verified facts embedded inline; full reports in project history. UI language established through mockup iteration, 2026-07; mockups in `reviewer/mockups/`.*
